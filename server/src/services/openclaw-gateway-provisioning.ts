import { execFile as execFileCb, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import { agentService } from "./agents.js";

const execFile = promisify(execFileCb);
const PROVISIONER_TIMEOUT_MS = 60_000;

type AgentRecord = {
  id: string;
  adapterType: string;
  adapterConfig: unknown;
};

type ActorAgentRecord = {
  adapterType: string;
  adapterConfig: unknown;
} | null;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
  return null;
}

export function canonicalizeOpenClawGatewayUrl(value: unknown): string {
  const raw = asNonEmptyString(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "ws:" && protocol !== "wss:") return raw;
    let hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") {
      hostname = "127.0.0.1";
    }
    const port = parsed.port ? `:${parsed.port}` : "";
    const pathname = parsed.pathname && parsed.pathname !== "/"
      ? parsed.pathname.replace(/\/+$/, "")
      : "";
    const search = parsed.search || "";
    return `${protocol}//${hostname}${port}${pathname}${search}`;
  } catch {
    return raw;
  }
}

export function isLocalOpenClawGatewayUrl(value: unknown): boolean {
  const raw = asNonEmptyString(value);
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return false;
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

function normalizeOpenClawAgentId(value: string): string {
  let normalized = "";
  for (const char of value.trim().toLowerCase()) {
    const isAsciiLetter = char >= "a" && char <= "z";
    const isDigit = char >= "0" && char <= "9";
    if (isAsciiLetter || isDigit) {
      if (normalized.length >= 48) break;
      normalized += char;
      continue;
    }
    if (normalized.length > 0 && normalized.length < 48 && !normalized.endsWith("-")) {
      normalized += "-";
    }
  }
  while (normalized.endsWith("-")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized || `agent-${randomUUID().slice(0, 8)}`;
}

function openClawWorkspacePathForAgent(agentId: string): string {
  return `~/.openclaw/workspace-${agentId}`;
}

function openClawClaimPathForAgent(agentId: string): string {
  return `${openClawWorkspacePathForAgent(agentId)}/paperclip-claimed-api-key.json`;
}

function expandOpenClawHome(rawPath: string): string {
  const home = process.env.PAPERCLIP_OPENCLAW_HOME || "/root";
  if (rawPath === "~") return home;
  if (rawPath.startsWith("~/")) return path.join(home, rawPath.slice(2));
  return rawPath;
}

function shouldAutoProvisionOpenClawGatewayChild(adapterConfig: Record<string, unknown>): boolean {
  if (process.env.PAPERCLIP_OPENCLAW_GATEWAY_AUTO_PROVISION === "0") return false;
  if (parseBooleanLike(adapterConfig.autoProvisionAgent) === false) return false;
  if (process.env.PAPERCLIP_OPENCLAW_GATEWAY_AUTO_PROVISION === "1") return true;
  if (process.env.NODE_ENV === "test") return false;
  return true;
}

function provisioningDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function redactedProcessOutput(value: string): string {
  return value
    .replace(/pcp_[a-f0-9]+/gi, "pcp_<redacted>")
    .replace(/"token"\s*:\s*"[^"]+"/gi, "\"token\":\"<redacted>\"")
    .trim();
}

function configuredProvisionerPath(): string | null {
  return asNonEmptyString(process.env.PAPERCLIP_OPENCLAW_PROVISIONER);
}

function openClawCommandEnv(): NodeJS.ProcessEnv {
  const home = asNonEmptyString(process.env.PAPERCLIP_OPENCLAW_HOME);
  if (!home) return process.env;
  const stateDir = path.join(home, ".openclaw");
  return {
    ...process.env,
    HOME: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR ?? stateDir,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json"),
  };
}

async function runProvisioner(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const provisioner = configuredProvisionerPath();
  if (!provisioner) {
    throw new Error("OpenClaw provisioner is not configured");
  }

  const useSudo = parseBooleanLike(process.env.PAPERCLIP_OPENCLAW_PROVISIONER_SUDO) === true;
  const command = useSudo ? "sudo" : provisioner;
  const args = useSudo ? ["-n", provisioner] : [];

  const child = spawn(command, args, {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, PROVISIONER_TIMEOUT_MS);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.stdin.end(JSON.stringify(payload) + "\n");

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => {
    clearTimeout(timeout);
  });

  if (exitCode !== 0) {
    const detail = redactedProcessOutput(stderr || stdout || `exit code ${exitCode}`);
    throw new Error(`provisioner failed: ${detail}`);
  }

  try {
    const parsed = JSON.parse(stdout);
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function readProvisioningFields(adapterConfig: Record<string, unknown>) {
  const agentId = asNonEmptyString(adapterConfig.agentId);
  if (!agentId || agentId === "main") return null;
  const workspacePath = asNonEmptyString(adapterConfig.openclawWorkspacePath)
    ?? openClawWorkspacePathForAgent(agentId);
  const claimPath = asNonEmptyString(adapterConfig.claimedApiKeyPath)
    ?? openClawClaimPathForAgent(agentId);
  const model = asNonEmptyString(adapterConfig.openclawModel)
    ?? process.env.PAPERCLIP_OPENCLAW_CHILD_MODEL
    ?? "openai/gpt-5.5";
  return {
    agentId,
    workspacePath,
    claimPath,
    expandedWorkspacePath: expandOpenClawHome(workspacePath),
    expandedClaimPath: expandOpenClawHome(claimPath),
    model,
  };
}

export function openClawGatewayProvisioningService(db: Db) {
  const agentsSvc = agentService(db);

  async function listCompanyOpenClawAgentIds(companyId: string): Promise<Set<string>> {
    const rows = await db
      .select({ adapterConfig: agentsTable.adapterConfig })
      .from(agentsTable)
      .where(and(eq(agentsTable.companyId, companyId), eq(agentsTable.adapterType, "openclaw_gateway")));
    const used = new Set<string>();
    for (const row of rows) {
      const agentId = asNonEmptyString(asRecord(row.adapterConfig)?.agentId);
      if (agentId) used.add(agentId);
    }
    return used;
  }

  async function deriveCompanyOpenClawAgentId(companyId: string, requestedName: string): Promise<string> {
    const used = await listCompanyOpenClawAgentIds(companyId);
    const base = normalizeOpenClawAgentId(requestedName);
    if (!used.has(base) && base !== "main") return base;
    for (let index = 2; index < 100; index += 1) {
      const candidate = `${base}-${index}`.slice(0, 56);
      if (!used.has(candidate) && candidate !== "main") return candidate;
    }
    return `${base}-${randomUUID().slice(0, 8)}`.slice(0, 56);
  }

  async function applySameGatewayOpenClawProvisioningDefaults(input: {
    companyId: string;
    requestedName: string;
    adapterType: string;
    adapterConfig: Record<string, unknown>;
    actorAgent: ActorAgentRecord;
  }): Promise<Record<string, unknown>> {
    if (
      input.adapterType !== "openclaw_gateway" ||
      !input.actorAgent ||
      input.actorAgent.adapterType !== "openclaw_gateway" ||
      !isLocalOpenClawGatewayUrl(input.adapterConfig.url)
    ) {
      return input.adapterConfig;
    }

    const next = { ...input.adapterConfig };
    let agentId = asNonEmptyString(next.agentId);
    if (!agentId) {
      agentId = await deriveCompanyOpenClawAgentId(input.companyId, input.requestedName);
      next.agentId = agentId;
    }
    if (agentId !== "main") {
      if (!asNonEmptyString(next.openclawWorkspacePath)) {
        next.openclawWorkspacePath = openClawWorkspacePathForAgent(agentId);
      }
      if (!asNonEmptyString(next.claimedApiKeyPath)) {
        next.claimedApiKeyPath = openClawClaimPathForAgent(agentId);
      }
    }
    return next;
  }

  async function listLocalOpenClawAgentIds(): Promise<Set<string>> {
    const { stdout } = await execFile("openclaw", ["agents", "list", "--json"], {
      timeout: 10_000,
      env: openClawCommandEnv(),
    });
    const parsed = JSON.parse(stdout);
    const agentsList = Array.isArray(parsed) ? parsed : parsed?.agents;
    const ids = new Set<string>();
    if (Array.isArray(agentsList)) {
      for (const agent of agentsList) {
        const id = asNonEmptyString(asRecord(agent)?.id);
        if (id) ids.add(id);
      }
    }
    return ids;
  }

  async function ensureOpenClawAgentForAdapterConfig(adapterConfig: Record<string, unknown>): Promise<void> {
    if (!shouldAutoProvisionOpenClawGatewayChild(adapterConfig)) return;
    if (!isLocalOpenClawGatewayUrl(adapterConfig.url)) return;
    const fields = readProvisioningFields(adapterConfig);
    if (!fields) return;

    if (configuredProvisionerPath()) {
      await runProvisioner({
        action: "ensure_agent",
        agentId: fields.agentId,
        workspacePath: fields.expandedWorkspacePath,
        claimPath: fields.expandedClaimPath,
        model: fields.model,
      });
      return;
    }

    const ids = await listLocalOpenClawAgentIds();
    if (ids.has(fields.agentId)) return;
    await execFile(
      "openclaw",
      [
        "agents",
        "add",
        fields.agentId,
        "--workspace",
        fields.expandedWorkspacePath,
        "--model",
        fields.model,
        "--non-interactive",
        "--json",
      ],
      { timeout: 60_000, env: openClawCommandEnv() },
    );
  }

  async function ensureOpenClawAgentForAdapterConfigOrThrow(adapterConfig: Record<string, unknown>): Promise<void> {
    try {
      await ensureOpenClawAgentForAdapterConfig(adapterConfig);
    } catch (err) {
      throw unprocessable(`openclaw_gateway_child_provisioning_failed: ${provisioningDetail(err)}`);
    }
  }

  async function writeLocalClaimFile(agent: AgentRecord, fields: ReturnType<typeof readProvisioningFields>) {
    if (!fields) return;
    const claimFile = fields.expandedClaimPath;
    try {
      const existing = JSON.parse(await fs.readFile(claimFile, "utf8"));
      if (existing?.agentId === agent.id && typeof existing?.token === "string") return;
      throw new Error(`claim file already exists for a different agent at ${fields.claimPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const key = await agentsSvc.createApiKey(agent.id, `OpenClaw ${fields.agentId} workspace claim`);
    try {
      await fs.mkdir(path.dirname(claimFile), { recursive: true });
      await fs.writeFile(
        claimFile,
        JSON.stringify({
          agentId: agent.id,
          keyId: key.id,
          token: key.token,
          createdAt: key.createdAt.toISOString(),
        }, null, 2) + "\n",
        { mode: 0o600 },
      );
      await fs.chmod(claimFile, 0o600);
    } catch (err) {
      await agentsSvc.revokeKey(agent.id, key.id).catch(() => null);
      throw err;
    }
  }

  async function ensureOpenClawProvisionedForAgent(agent: AgentRecord): Promise<void> {
    const adapterConfig = asRecord(agent.adapterConfig) ?? {};
    if (!shouldAutoProvisionOpenClawGatewayChild(adapterConfig)) return;
    if (!isLocalOpenClawGatewayUrl(adapterConfig.url)) return;
    const fields = readProvisioningFields(adapterConfig);
    if (!fields) return;

    if (configuredProvisionerPath()) {
      const key = await agentsSvc.createApiKey(agent.id, `OpenClaw ${fields.agentId} workspace claim`);
      try {
        await runProvisioner({
          action: "ensure_agent_claim",
          agentId: fields.agentId,
          workspacePath: fields.expandedWorkspacePath,
          claimPath: fields.expandedClaimPath,
          model: fields.model,
          paperclipAgentId: agent.id,
          paperclipKeyId: key.id,
          paperclipApiKey: key.token,
          paperclipApiKeyCreatedAt: key.createdAt.toISOString(),
          claim: {
            agentId: agent.id,
            keyId: key.id,
            token: key.token,
            createdAt: key.createdAt.toISOString(),
          },
        });
      } catch (err) {
        await agentsSvc.revokeKey(agent.id, key.id).catch(() => null);
        throw err;
      }
      return;
    }

    await ensureOpenClawAgentForAdapterConfig(adapterConfig);
    await writeLocalClaimFile(agent, fields);
  }

  async function ensureOpenClawProvisionedForAgentOrThrow(agent: AgentRecord): Promise<void> {
    try {
      await ensureOpenClawProvisionedForAgent(agent);
    } catch (err) {
      throw unprocessable(`openclaw_gateway_child_claim_file_failed: ${provisioningDetail(err)}`);
    }
  }

  return {
    applySameGatewayOpenClawProvisioningDefaults,
    ensureOpenClawAgentForAdapterConfig,
    ensureOpenClawAgentForAdapterConfigOrThrow,
    ensureOpenClawProvisionedForAgent,
    ensureOpenClawProvisionedForAgentOrThrow,
  };
}
