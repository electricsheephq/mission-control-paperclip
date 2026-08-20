import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agentConfigRevisions, agents, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { nextAgentUpdatedAt } from "../services/agent-updated-at.ts";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping agent CAS tests: ${support.reason ?? "unsupported environment"}`);

describePg("agent service PATCH CAS", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => { tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-cas-"); db = createDb(tempDb.connectionString); }, 20_000);
  afterEach(async () => { await db.delete(agentConfigRevisions); await db.delete(agents); await db.delete(companies); });
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seed(config: Record<string, unknown> = {}, updatedAt = new Date()) {
    const companyId = randomUUID(); const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: config, runtimeConfig: {}, permissions: {}, updatedAt });
    return { agentId, updatedAt };
  }
  async function row(agentId: string) { return (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!; }

  it("matches CAS, rejects stale CAS without mutation, and commits one config revision", async () => {
    const at = new Date("2026-08-20T01:02:03.004Z"); const s = await seed({ model: "old" }, at); const service = agentService(db);
    const first = await service.update(s.agentId, { name: "Winner", adapterConfig: { model: "new" } }, { expectedUpdatedAt: at, recordRevision: { source: "cas-test" } });
    expect(first?.updatedAt.getTime()).toBeGreaterThan(at.getTime());
    await expect(service.update(s.agentId, { name: "Stale", adapterConfig: { model: "secret-should-not-leak" } }, { expectedUpdatedAt: at, recordRevision: { source: "cas-test" } })).rejects.toMatchObject({ status: 409, message: "agent_revision_conflict" });
    const current = await row(s.agentId); expect(current).toMatchObject({ name: "Winner", adapterConfig: { model: "new" } }); expect(JSON.stringify(current)).not.toContain("secret-should-not-leak");
    expect((await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, s.agentId)))).toHaveLength(1);
  });

  it("allows legacy updates and advances timestamps strictly within one millisecond", async () => {
    const at = new Date(Date.now()); const s = await seed({}, at); const service = agentService(db);
    const first = await service.update(s.agentId, { name: "First" }); const second = await service.update(s.agentId, { name: "Second" });
    expect(first?.updatedAt.getTime()).toBeGreaterThan(at.getTime()); expect(second?.updatedAt.getTime()).toBeGreaterThan(first!.updatedAt.getTime());
  });

  it("serializes two concurrent expectedUpdatedAt callers into one winner and one conflict", async () => {
    const at = new Date("2026-08-20T01:02:03.004Z"); const s = await seed({}, at); const service = agentService(db);
    const results = await Promise.allSettled([service.update(s.agentId, { name: "A" }, { expectedUpdatedAt: at }), service.update(s.agentId, { name: "B" }, { expectedUpdatedAt: at })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1); expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 409, message: "agent_revision_conflict" } }); expect(["A", "B"]).toContain((await row(s.agentId)).name);
  });

  it("advances API-visible revisions across PostgreSQL microseconds and rejects stale CAS", async () => {
    const at = new Date("2026-08-20T01:02:03.004Z"); const s = await seed({}, at); const service = agentService(db);
    await db.execute(sql`UPDATE ${agents} SET updated_at = '2026-08-20T01:02:03.004500Z'::timestamptz WHERE ${agents.id} = ${s.agentId}`);
    const initial = await row(s.agentId);
    await db.update(agents).set({ status: "running", updatedAt: nextAgentUpdatedAt() }).where(eq(agents.id, s.agentId));
    const first = await row(s.agentId);
    await db.update(agents).set({ status: "idle", updatedAt: nextAgentUpdatedAt() }).where(eq(agents.id, s.agentId));
    const second = await row(s.agentId);
    expect(first.updatedAt.getTime()).toBeGreaterThan(initial.updatedAt.getTime()); expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
    await expect(service.update(s.agentId, { name: "Stale" }, { expectedUpdatedAt: initial.updatedAt })).rejects.toMatchObject({ status: 409, message: "agent_revision_conflict" });
  });

  it("rolls back the agent when config revision insertion fails", async () => {
    const at = new Date("2026-08-20T01:02:03.004Z"); const s = await seed({ model: "old" }, at); const service = agentService(db);
    await expect(service.update(s.agentId, { adapterConfig: { model: "new" } }, { recordRevision: { source: "rollback-test", createdByAgentId: "not-a-uuid" } })).rejects.toThrow();
    const current = await row(s.agentId); expect(current).toMatchObject({ adapterConfig: { model: "old" } }); expect(current.updatedAt.getTime()).toBe(at.getTime()); expect((await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, s.agentId)))).toHaveLength(0);
  });
});
