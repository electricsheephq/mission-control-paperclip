import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, ensurePostgresDatabase, inspectMigrations, reconcilePendingMigrationHistory } from "./client.js";
import { __startEmbeddedPostgresWithRetryForTests } from "./test-embedded-postgres.js";
const cleanups: Array<() => Promise<void>> = [];
const migrationsRoot = fileURLToPath(new URL("./migrations", import.meta.url)), repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()?.(); });
async function availablePort(): Promise<number> { const server = net.createServer(); await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject)); const port = (server.address() as net.AddressInfo).port; await new Promise<void>((resolve) => server.close(() => resolve())); return port; }
async function legacyMigrationsFolder(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-0102-migrations-"));
  const meta = path.join(root, "meta"); await mkdir(meta);
  const journal = JSON.parse(await readFile(path.join(migrationsRoot, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 102);
  for (const entry of journal.entries) await copyFile(path.join(migrationsRoot, `${entry.tag}.sql`), path.join(root, `${entry.tag}.sql`));
  await writeFile(path.join(meta, "_journal.json"), JSON.stringify(journal));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fullDataSnapshot(sql: postgres.Sql): Promise<Record<string, unknown>> {
  const tables = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '__drizzle_migrations' ORDER BY table_name`;
  const snapshot: Record<string, unknown> = {};
  for (const { table_name } of tables) {
    if (!/^[a-z0-9_]+$/.test(table_name)) throw new Error("unsafe table name");
    const rows = await sql.unsafe<{ rows: unknown }[]>(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM "${table_name}" t`);
    snapshot[table_name] = rows[0]?.rows;
  }
  return snapshot;
}
const stableLegacyColumns: Record<string, string> = {
  companies: "id,name,issue_prefix,issue_counter", company_memberships: "company_id,principal_type,principal_id,status,membership_role", issues: "id,company_id,title,status,identifier,issue_number,created_by_user_id,execution_locked_at,assignee_agent_id",
  heartbeat_runs: "id,company_id,agent_id,status,error,context_snapshot,finished_at", approvals: "id,company_id,type,requested_by_agent_id,status,payload", environments: "id,name,driver", agent_config_revisions: "id,company_id,agent_id,source,changed_keys,before_config,after_config", issue_thread_interactions: "id,company_id,issue_id,kind,status,payload,created_by_user_id",
};
async function legacySemanticSnapshot(sql: postgres.Sql): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [table, columns] of Object.entries(stableLegacyColumns)) result[table] = await sql.unsafe(`SELECT ${columns} FROM ${table} ORDER BY 1`);
  return result;
}
async function runServerOnce(url: string, sql: postgres.Sql): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-0102-server-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "config.json"), listenPort = await availablePort();
  await writeFile(configPath, JSON.stringify({
    $meta: { version: 1, updatedAt: "2026-01-01T00:00:00Z", source: "configure" }, database: { mode: "postgres", connectionString: url, backup: { enabled: false } }, logging: { mode: "file", logDir: path.join(root, "logs") },
    server: { host: "127.0.0.1", port: listenPort, serveUi: false }, storage: { provider: "local_disk", localDisk: { baseDir: path.join(root, "storage") } },
    secrets: { provider: "local_encrypted", localEncrypted: { keyFilePath: path.join(root, "key") } }, telemetry: { enabled: false }, updates: { checkEnabled: false },
  }));
  const child = spawn(path.join(repositoryRoot, "server/node_modules/.bin/tsx"), ["server/src/index.ts"], {
    cwd: repositoryRoot,
    env: { ...process.env, PORT: String(listenPort), DATABASE_URL: url, DATABASE_MIGRATION_URL: url, PAPERCLIP_CONFIG: configPath, PAPERCLIP_RECONCILE_BUILT_IN_AGENTS_ON_STARTUP: "0", PAPERCLIP_MIGRATION_AUTO_APPLY: "true", PAPERCLIP_OPEN_ON_LISTEN: "false",
      PAPERCLIP_DECISION_SIGNING_SECRET: "0123456789abcdef0123456789abcdef", PAPERCLIP_SECRETS_MASTER_KEY: "0".repeat(64), HEARTBEAT_SCHEDULER_ENABLED: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  let spawnError: Error | undefined;
  child.once("error", (error) => { spawnError = error; });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const stopChild = async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]); };
  cleanups.push(stopChild);
  try {
    const deadline = Date.now() + 60_000;
    let previous = "", stablePolls = 0, healthSeen = false;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null) throw new Error(`server exited: ${spawnError ?? child.exitCode}: ${output.slice(-1000)}`);
      try {
        if ((await fetch(`http://127.0.0.1:${listenPort}/api/health`)).ok) {
          healthSeen = true;
          const current = JSON.stringify(await fullDataSnapshot(sql));
          stablePolls = current === previous ? stablePolls + 1 : 0; previous = current;
          if (stablePolls >= 5) return;
        }
      } catch { /* Wait for health and a stable post-reconciliation database. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`server startup timeout (healthSeen=${healthSeen}, stablePolls=${stablePolls}): ${output.slice(-1000)}`);
  } finally { await stopChild(); }
}
describe.sequential("legacy 0102 migration replay", () => {
  it("preserves a four-company paused-agent fixture through 0226", async () => {
    const cluster = await __startEmbeddedPostgresWithRetryForTests("paperclip-0102-replay-");
    cleanups.push(async () => { const stopped = cluster.instance.stop().finally(() => rm(cluster.dataDir, { recursive: true, force: true })); await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 5_000))]); });
    const adminUrl = `postgres://paperclip:paperclip@127.0.0.1:${cluster.port}/postgres`;
    await ensurePostgresDatabase(adminUrl, "paperclip");
    const url = `postgres://paperclip:paperclip@127.0.0.1:${cluster.port}/paperclip`;
    let sql = postgres(url, { max: 1, onnotice: () => {} });
    cleanups.push(() => sql.end());
    const legacyFolder = await legacyMigrationsFolder();
    await migrate(drizzle(sql), { migrationsFolder: legacyFolder });
    const companyIds = Array.from({ length: 4 }, () => randomUUID());
    const agentIds = Array.from({ length: 8 }, () => randomUUID()), issueIds = companyIds.map(() => randomUUID());
    const environmentId = randomUUID();
    await sql`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at) VALUES ('local-board','Board','local@paperclip.local',true,now(),now())`;
    await sql`INSERT INTO instance_user_roles (user_id, role) VALUES ('local-board', 'instance_admin')`;
    for (const [index, companyId] of companyIds.entries()) {
      await sql`INSERT INTO companies (id,name,issue_prefix,issue_counter) VALUES (${companyId},${`Synthetic ${index + 1}`},${`S${index + 1}`},1)`;
      await sql`INSERT INTO company_memberships (company_id,principal_type,principal_id,status,membership_role) VALUES
        (${companyId},'user',${`owner-${index + 1}`},'active','owner'),(${companyId},'user','local-board','active','owner')`;
    }
    await sql`INSERT INTO environments (id,company_id,name,driver,metadata) VALUES (${environmentId},${companyIds[0]!},'Local','local','{"managedByPaperclip":true}')`;
    for (const [index, agentId] of agentIds.entries()) {
      const companyId = companyIds[index % 4]!;
      const status = index === 7 ? "terminated" : "paused";
      const adapterType = index < 4 ? "openclaw_gateway" : "hermes_local";
      const adapterConfig = adapterType === "hermes_local"
        ? { model: "synthetic-model", provider: "openai-codex", extraArgs: ["--profile", "synthetic"] }
        : { endpoint: "http://127.0.0.1:1", retired: true };
      await sql`INSERT INTO agents (id,company_id,name,status,adapter_type,adapter_config,default_environment_id,pause_reason) VALUES
        (${agentId},${companyId},${`Agent ${index + 1}`},${status},${adapterType},${JSON.stringify(adapterConfig)}::jsonb,${index === 0 ? environmentId : null},'synthetic fixture')`;
      if (status !== "terminated") await sql`INSERT INTO company_memberships (company_id,principal_type,principal_id,status,membership_role) VALUES (${companyId},'agent',${agentId},'active','member')`;
    }
    for (const [index, issueId] of issueIds.entries()) {
      await sql`INSERT INTO issues (id,company_id,title,status,identifier,issue_number,created_by_user_id,execution_locked_at,assignee_agent_id) VALUES
        (${issueId},${companyIds[index]!},${`Issue ${index + 1}`},'backlog',${`S${index + 1}-1`},1,${`owner-${index + 1}`},${index === 0 ? "2026-01-01T00:00:00Z" : null},${agentIds[index]!})`;
    }
    const runId = randomUUID();
    await sql`INSERT INTO heartbeat_runs (id,company_id,agent_id,status,error,context_snapshot,finished_at) VALUES (${runId},${companyIds[0]!},${agentIds[0]!},'failed','synthetic failure',${JSON.stringify({ issueId: issueIds[0] })}::jsonb,'2026-01-01T00:05:00Z')`;
    const [approval] = await sql<{ id: string }[]>`INSERT INTO approvals (company_id,type,requested_by_agent_id,status,payload) VALUES (${companyIds[0]!},'agent_hire',${agentIds[0]!},'pending','{}') RETURNING id`;
    await sql`INSERT INTO activity_log (company_id,actor_type,actor_id,action,entity_type,entity_id,agent_id,run_id) VALUES (${companyIds[0]!},'system','fixture','seeded','heartbeat_run',${runId},${agentIds[0]!},${runId})`;
    const [seedGrant] = await sql<{ id: string }[]>`INSERT INTO principal_permission_grants (company_id,principal_type,principal_id,permission_key) VALUES (${companyIds[0]!},'user','owner-1','issues:read') RETURNING id`;
    await sql`INSERT INTO agent_config_revisions (company_id,agent_id,source,changed_keys,before_config,after_config) VALUES (${companyIds[0]!},${agentIds[0]!},'fixture','["adapterConfig"]','{}','{}')`;
    await sql`INSERT INTO issue_thread_interactions (company_id,issue_id,kind,status,payload,created_by_user_id) VALUES (${companyIds[0]!},${issueIds[0]!},'request_confirmation','resolved','{"resolverPolicy":"board_only"}','owner-1')`;
    await sql.end();
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe('CREATE DATABASE "paperclip_startup" TEMPLATE "paperclip"'); await admin.end();
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const protectedBefore = await sql`SELECT id,company_id,name,status,adapter_type,adapter_config,runtime_config,default_environment_id,pause_reason FROM agents ORDER BY id`;
    const activityBefore = await sql`SELECT id,company_id,actor_type,actor_id,action,entity_type,entity_id,agent_id,run_id,details,created_at FROM activity_log ORDER BY id`;
    const legacyBefore = await legacySemanticSnapshot(sql);
    const repairBefore = await reconcilePendingMigrationHistory(url);
    expect(repairBefore.repairedMigrations).toEqual([]);
    await applyPendingMigrations(url);
    const finalState = await inspectMigrations(url);
    expect(finalState.status).toBe("upToDate");
    expect(finalState.appliedMigrations.at(-1)).toBe("0226_tan_colossus.sql");
    expect(await sql`SELECT id,company_id,name,status,adapter_type,adapter_config,runtime_config,default_environment_id,pause_reason FROM agents ORDER BY id`).toEqual(protectedBefore);
    expect(await sql`SELECT id,company_id,actor_type,actor_id,action,entity_type,entity_id,agent_id,run_id,details,created_at FROM activity_log ORDER BY id`).toEqual(activityBefore);
    expect(await legacySemanticSnapshot(sql)).toEqual(legacyBefore);
    expect(await sql`SELECT company_id,principal_type,principal_id,permission_key,scope FROM principal_permission_grants WHERE id=${seedGrant!.id}`).toEqual([{ company_id: companyIds[0], principal_type: "user", principal_id: "owner-1", permission_key: "issues:read", scope: null }]);
    expect(await sql`SELECT count(*)::int AS count FROM adapter_auth_sessions`).toEqual([{ count: 0 }]);
    expect(await sql`SELECT count(*)::int AS count FROM built_in_managed_resources`).toEqual([{ count: 0 }]);
    expect(await sql`SELECT id FROM environments ORDER BY id`).toEqual([{ id: environmentId }]);
    expect(await sql`SELECT count(*)::int AS count FROM agents WHERE status = 'paused'`).toEqual([{ count: 7 }]);
    expect(await sql`SELECT count(*)::int AS count FROM agents WHERE status = 'terminated'`).toEqual([{ count: 1 }]);
    expect(await sql`SELECT count(*)::int AS count FROM principal_permission_grants WHERE permission_key='skills:create'`).toEqual([{ count: 8 }]);
    const afterFirst = await fullDataSnapshot(sql);
    await runServerOnce(url, sql);
    const afterStartup = await fullDataSnapshot(sql);
    const changedTables = [...new Set([...Object.keys(afterFirst), ...Object.keys(afterStartup)])]
      .filter((table) => JSON.stringify(afterFirst[table]) !== JSON.stringify(afterStartup[table]));
    expect(changedTables).toEqual(["decision_retention", "principal_permission_grants"]);
    const rows = (snapshot: Record<string, unknown>, table: string) => snapshot[table] as Record<string, unknown>[];
    for (const table of changedTables) {
      const ids = new Set(rows(afterFirst, table).map((row) => row.id));
      expect(rows(afterStartup, table).filter((row) => ids.has(row.id))).toEqual(rows(afterFirst, table));
    }
    const added = (table: string) => {
      const ids = new Set(rows(afterFirst, table).map((row) => row.id));
      return rows(afterStartup, table).filter((row) => !ids.has(row.id));
    };
    expect(added("decision_retention").map(({ company_id, source_kind, source_id, keep, version }) =>
      ({ company_id, source_kind, source_id, keep, version }))).toEqual([
      { company_id: companyIds[0], source_kind: "approval", source_id: approval!.id, keep: false, version: 1 },
    ]);
    const permissions = ["agents:create", "agents:configure", "users:invite", "users:manage_permissions", "joins:approve", "tasks:assign", "environments:manage"];
    const expectedGrants = companyIds.flatMap((company_id, index) => ["local-board", `owner-${index + 1}`].flatMap((principal_id) =>
      permissions.map((permission_key) => ({ company_id, principal_type: "user", principal_id, permission_key, scope: null }))));
    const grantKey = (row: Record<string, unknown>) => JSON.stringify(row);
    expect(added("principal_permission_grants").map(({ company_id, principal_type, principal_id, permission_key, scope }) =>
      ({ company_id, principal_type, principal_id, permission_key, scope })).sort((a, b) => grantKey(a).localeCompare(grantKey(b))))
      .toEqual(expectedGrants.sort((a, b) => grantKey(a).localeCompare(grantKey(b))));
    expect(await sql`SELECT id, company_id, name, status, adapter_type, adapter_config,
      runtime_config, default_environment_id, pause_reason FROM agents ORDER BY id`).toEqual(protectedBefore);
    expect(await sql`SELECT id, company_id, actor_type, actor_id, action, entity_type,
      entity_id, agent_id, run_id, details, created_at FROM activity_log ORDER BY id`).toEqual(activityBefore);
    await runServerOnce(url, sql);
    expect(await fullDataSnapshot(sql)).toEqual(afterStartup);
    await applyPendingMigrations(url);
    expect((await reconcilePendingMigrationHistory(url)).repairedMigrations).toEqual([]);
    expect(await fullDataSnapshot(sql)).toEqual(afterStartup);
    const startupUrl = `postgres://paperclip:paperclip@127.0.0.1:${cluster.port}/paperclip_startup`, startupSql = postgres(startupUrl, { max: 1, onnotice: () => {} });
    await runServerOnce(startupUrl, startupSql);
    expect((await inspectMigrations(startupUrl)).appliedMigrations.at(-1)).toBe("0226_tan_colossus.sql");
    expect(await legacySemanticSnapshot(startupSql)).toEqual(legacyBefore);
    expect(await startupSql`SELECT id,company_id,name,status,adapter_type,adapter_config,runtime_config,default_environment_id,pause_reason FROM agents ORDER BY id`).toEqual(protectedBefore);
    await startupSql.end();
  }, 360_000);
});
