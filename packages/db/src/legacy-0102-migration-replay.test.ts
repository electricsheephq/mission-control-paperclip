import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, ensurePostgresDatabase, inspectMigrations,
  reconcilePendingMigrationHistory } from "./client.js";
import { __startEmbeddedPostgresWithRetryForTests } from "./test-embedded-postgres.js";
const cleanups: Array<() => Promise<void>> = [];
const migrationsRoot = fileURLToPath(new URL("./migrations", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});
async function legacyMigrationsFolder(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-0102-migrations-"));
  const meta = path.join(root, "meta");
  await mkdir(meta);
  const journal = JSON.parse(await readFile(path.join(migrationsRoot, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 102);
  for (const entry of journal.entries) {
    await copyFile(path.join(migrationsRoot, `${entry.tag}.sql`), path.join(root, `${entry.tag}.sql`));
  }
  await writeFile(path.join(meta, "_journal.json"), JSON.stringify(journal));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fullDataSnapshot(sql: postgres.Sql): Promise<Record<string, unknown>> {
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      AND table_name <> '__drizzle_migrations'
    ORDER BY table_name
  `;
  const snapshot: Record<string, unknown> = {};
  for (const { table_name } of tables) {
    if (!/^[a-z0-9_]+$/.test(table_name)) throw new Error("unsafe table name");
    const rows = await sql.unsafe<{ rows: unknown }[]>(
      `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM "${table_name}" t`,
    );
    snapshot[table_name] = rows[0]?.rows;
  }
  return snapshot;
}
async function runServerOnce(url: string): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-0102-server-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, JSON.stringify({
    $meta: { version: 1, updatedAt: "2026-01-01T00:00:00Z", source: "configure" },
    database: { mode: "postgres", connectionString: url, backup: { enabled: false } },
    logging: { mode: "file", logDir: path.join(root, "logs") },
    server: { host: "127.0.0.1", port: 39100, serveUi: false },
    storage: { provider: "local_disk", localDisk: { baseDir: path.join(root, "storage") } },
    secrets: { provider: "local_encrypted", localEncrypted: { keyFilePath: path.join(root, "key") } },
    telemetry: { enabled: false }, updates: { checkEnabled: false },
  }));
  const child = spawn(path.join(repositoryRoot, "server/node_modules/.bin/tsx"), ["server/src/index.ts"], {
    cwd: repositoryRoot,
    env: { ...process.env, PAPERCLIP_CONFIG: configPath, DATABASE_URL: url,
      PAPERCLIP_RECONCILE_BUILT_IN_AGENTS_ON_STARTUP: "0",
      PAPERCLIP_MIGRATION_AUTO_APPLY: "true", PAPERCLIP_OPEN_ON_LISTEN: "false",
      PAPERCLIP_DECISION_SIGNING_SECRET: "0123456789abcdef0123456789abcdef",
      PAPERCLIP_SECRETS_MASTER_KEY: "0".repeat(64), HEARTBEAT_SCHEDULER_ENABLED: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server startup timeout: ${output.slice(-1000)}`)), 30_000);
    const poll = setInterval(() => {
      if (!output.includes("Migrations")) return;
      clearInterval(poll); clearTimeout(timeout); child.kill("SIGTERM"); resolve();
    }, 50);
    child.once("exit", (code) => { if (!output.includes("Migrations")) reject(new Error(`server exited ${code}: ${output.slice(-1000)}`)); });
  });
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
describe.sequential("legacy 0102 migration replay", () => {
  it("preserves a four-company paused-agent fixture through 0226", async () => {
    const cluster = await __startEmbeddedPostgresWithRetryForTests("paperclip-0102-replay-");
    cleanups.push(async () => {
      await cluster.instance.stop();
      await rm(cluster.dataDir, { recursive: true, force: true });
    });
    const adminUrl = `postgres://paperclip:paperclip@127.0.0.1:${cluster.port}/postgres`;
    await ensurePostgresDatabase(adminUrl, "paperclip");
    const url = `postgres://paperclip:paperclip@127.0.0.1:${cluster.port}/paperclip`;
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    cleanups.push(() => sql.end());
    const legacyFolder = await legacyMigrationsFolder();
    await migrate(drizzle(sql), { migrationsFolder: legacyFolder });
    const companyIds = Array.from({ length: 4 }, () => randomUUID());
    const agentIds = Array.from({ length: 8 }, () => randomUUID()), issueIds = companyIds.map(() => randomUUID());
    const environmentId = randomUUID();
    await sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('local-board', 'Board', 'local@paperclip.local', true, now(), now())`;
    await sql`INSERT INTO instance_user_roles (user_id, role) VALUES ('local-board', 'instance_admin')`;
    for (const [index, companyId] of companyIds.entries()) {
      await sql`INSERT INTO companies (id, name, issue_prefix, issue_counter)
        VALUES (${companyId}, ${`Synthetic ${index + 1}`}, ${`S${index + 1}`}, 1)`;
      await sql`INSERT INTO company_memberships
        (company_id, principal_type, principal_id, status, membership_role)
        VALUES (${companyId}, 'user', ${`owner-${index + 1}`}, 'active', 'owner')`;
      await sql`INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role)
        VALUES (${companyId}, 'user', 'local-board', 'active', 'owner')`;
    }
    await sql`INSERT INTO environments (id, company_id, name, driver, metadata)
      VALUES (${environmentId}, ${companyIds[0]!}, 'Local', 'local', '{"managedByPaperclip":true}')`;
    for (const [index, agentId] of agentIds.entries()) {
      const companyId = companyIds[index % 4]!;
      const status = index === 7 ? "terminated" : "paused";
      const adapterType = index < 4 ? "openclaw_gateway" : "hermes_local";
      const adapterConfig = adapterType === "hermes_local"
        ? { model: "synthetic-model", provider: "openai-codex", extraArgs: ["--profile", "synthetic"] }
        : { endpoint: "http://127.0.0.1:1", retired: true };
      await sql`INSERT INTO agents
        (id, company_id, name, status, adapter_type, adapter_config, default_environment_id, pause_reason)
        VALUES (${agentId}, ${companyId}, ${`Agent ${index + 1}`}, ${status}, ${adapterType},
          ${JSON.stringify(adapterConfig)}::jsonb, ${index === 0 ? environmentId : null}, 'synthetic fixture')`;
      if (status !== "terminated") {
        await sql`INSERT INTO company_memberships
          (company_id, principal_type, principal_id, status, membership_role)
          VALUES (${companyId}, 'agent', ${agentId}, 'active', 'member')`;
      }
    }
    for (const [index, issueId] of issueIds.entries()) {
      await sql`INSERT INTO issues
        (id, company_id, title, status, identifier, issue_number, created_by_user_id,
          execution_locked_at, assignee_agent_id)
        VALUES (${issueId}, ${companyIds[index]!}, ${`Issue ${index + 1}`}, 'backlog',
          ${`S${index + 1}-1`}, 1, ${`owner-${index + 1}`},
          ${index === 0 ? "2026-01-01T00:00:00Z" : null}, ${agentIds[index]!})`;
    }
    const runId = randomUUID();
    await sql`INSERT INTO heartbeat_runs
      (id, company_id, agent_id, status, error, context_snapshot, finished_at)
      VALUES (${runId}, ${companyIds[0]!}, ${agentIds[0]!}, 'failed', 'synthetic failure',
        ${JSON.stringify({ issueId: issueIds[0] })}::jsonb, '2026-01-01T00:05:00Z')`;
    await sql`INSERT INTO approvals (company_id, type, requested_by_agent_id, status, payload)
      VALUES (${companyIds[0]!}, 'agent_hire', ${agentIds[0]!}, 'pending', '{}')`;
    await sql`INSERT INTO activity_log
      (company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, run_id)
      VALUES (${companyIds[0]!}, 'system', 'fixture', 'seeded', 'heartbeat_run', ${runId},
        ${agentIds[0]!}, ${runId})`;
    await sql`INSERT INTO principal_permission_grants
      (company_id, principal_type, principal_id, permission_key)
      VALUES (${companyIds[0]!}, 'user', 'owner-1', 'issues:read')`;
    await sql`INSERT INTO agent_config_revisions
      (company_id, agent_id, source, changed_keys, before_config, after_config)
      VALUES (${companyIds[0]!}, ${agentIds[0]!}, 'fixture', '["adapterConfig"]', '{}', '{}')`;
    await sql`INSERT INTO issue_thread_interactions
      (company_id, issue_id, kind, status, payload, created_by_user_id)
      VALUES (${companyIds[0]!}, ${issueIds[0]!}, 'request_confirmation', 'resolved',
        '{"resolverPolicy":"board_only"}', 'owner-1')`;
    const protectedBefore = await sql`SELECT id, company_id, name, status, adapter_type,
      adapter_config, runtime_config, default_environment_id, pause_reason FROM agents ORDER BY id`;
    const activityBefore = await sql`SELECT id, company_id, actor_type, actor_id, action,
      entity_type, entity_id, agent_id, run_id, details, created_at FROM activity_log ORDER BY id`;
    const repairBefore = await reconcilePendingMigrationHistory(url);
    expect(repairBefore.repairedMigrations).toEqual([]);
    await applyPendingMigrations(url);
    const finalState = await inspectMigrations(url);
    expect(finalState.status).toBe("upToDate");
    expect(finalState.appliedMigrations.at(-1)).toBe("0226_tan_colossus.sql");
    expect(await sql`SELECT id, company_id, name, status, adapter_type, adapter_config,
      runtime_config, default_environment_id, pause_reason FROM agents ORDER BY id`).toEqual(protectedBefore);
    expect(await sql`SELECT id, company_id, actor_type, actor_id, action, entity_type,
      entity_id, agent_id, run_id, details, created_at FROM activity_log ORDER BY id`).toEqual(activityBefore);
    expect(await sql`SELECT count(*)::int AS count FROM adapter_auth_sessions`).toEqual([{ count: 0 }]);
    expect(await sql`SELECT count(*)::int AS count FROM built_in_managed_resources`).toEqual([{ count: 0 }]);
    expect(await sql`SELECT id FROM environments ORDER BY id`).toEqual([{ id: environmentId }]);
    expect(await sql`SELECT count(*)::int AS count FROM agents WHERE status = 'paused'`).toEqual([{ count: 7 }]);
    expect(await sql`SELECT count(*)::int AS count FROM agents WHERE status = 'terminated'`).toEqual([{ count: 1 }]);
    expect(await sql`SELECT count(*)::int AS count FROM principal_permission_grants
      WHERE permission_key = 'skills:create'`).toEqual([{ count: 8 }]);
    const afterFirst = await fullDataSnapshot(sql);
    await runServerOnce(url);
    const afterStartup = await fullDataSnapshot(sql);
    const changedTables = Object.keys(afterFirst).filter(
      (table) => JSON.stringify(afterFirst[table]) !== JSON.stringify(afterStartup[table]),
    );
    expect(changedTables).toEqual(["decision_retention", "principal_permission_grants"]);
    expect(await sql`SELECT id, company_id, name, status, adapter_type, adapter_config,
      runtime_config, default_environment_id, pause_reason FROM agents ORDER BY id`).toEqual(protectedBefore);
    expect(await sql`SELECT id, company_id, actor_type, actor_id, action, entity_type,
      entity_id, agent_id, run_id, details, created_at FROM activity_log ORDER BY id`).toEqual(activityBefore);
    await runServerOnce(url);
    expect(await fullDataSnapshot(sql)).toEqual(afterStartup);
    await applyPendingMigrations(url);
    expect((await reconcilePendingMigrationHistory(url)).repairedMigrations).toEqual([]);
    expect(await fullDataSnapshot(sql)).toEqual(afterStartup);
  }, 120_000);
});
