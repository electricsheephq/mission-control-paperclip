import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeOpenClawGatewayUrl,
  openClawGatewayUrlSqlCandidates,
  openClawGatewayProvisioningService,
} from "../services/openclaw-gateway-provisioning.js";

const mockAgentService = vi.hoisted(() => ({
  createApiKey: vi.fn(),
  revokeKey: vi.fn(),
}));

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

describe("openClawGatewayProvisioningService", () => {
  const originalEnv = { ...process.env };

  function createDbWithOpenClawAgentIds(agentIds: string[]) {
    return {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() =>
            Promise.resolve(
              agentIds.map((agentId) => ({
                adapterConfig: { agentId },
              })),
            ),
          ),
        })),
      })),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.PAPERCLIP_OPENCLAW_GATEWAY_AUTO_PROVISION = "1";
    delete process.env.PAPERCLIP_OPENCLAW_PROVISIONER_SUDO;
    mockAgentService.createApiKey.mockResolvedValue({
      id: "key-1",
      token: "pcp_secret_value",
      createdAt: new Date("2026-05-22T00:00:00.000Z"),
    });
    mockAgentService.revokeKey.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("canonicalizes loopback OpenClaw gateway URLs into one shared bucket key", () => {
    expect(canonicalizeOpenClawGatewayUrl("ws://localhost:18790/")).toBe("ws://127.0.0.1:18790");
    expect(canonicalizeOpenClawGatewayUrl("ws://127.0.0.1:18790")).toBe("ws://127.0.0.1:18790");
    expect(canonicalizeOpenClawGatewayUrl("ws://[::1]:18790/")).toBe("ws://127.0.0.1:18790");
    expect(openClawGatewayUrlSqlCandidates("ws://localhost:18790/")).toEqual(expect.arrayContaining([
      "ws://127.0.0.1:18790",
      "ws://127.0.0.1:18790/",
      "ws://localhost:18790",
      "ws://localhost:18790/",
      "ws://[::1]:18790",
      "ws://[::1]:18790/",
    ]));
  });

  it("derives child agent provisioning fields for local invite approvals", async () => {
    const svc = openClawGatewayProvisioningService(
      createDbWithOpenClawAgentIds([]) as never,
    );

    const result = await svc.applyLocalOpenClawProvisioningDefaults({
      companyId: "company-1",
      requestedName: "SEO Manager",
      adapterType: "openclaw_gateway",
      adapterConfig: {
        url: "ws://127.0.0.1:18790/",
      },
    });

    expect(result).toMatchObject({
      agentId: "seo-manager",
      openclawWorkspacePath: "~/.openclaw/workspace-seo-manager",
      claimedApiKeyPath:
        "~/.openclaw/workspace-seo-manager/paperclip-claimed-api-key.json",
    });
  });

  it("deduplicates local invite approval child agent ids", async () => {
    const svc = openClawGatewayProvisioningService(
      createDbWithOpenClawAgentIds(["seo-manager"]) as never,
    );

    const result = await svc.applyLocalOpenClawProvisioningDefaults({
      companyId: "company-1",
      requestedName: "SEO Manager",
      adapterType: "openclaw_gateway",
      adapterConfig: {
        url: "ws://127.0.0.1:18790/",
      },
    });

    expect(result).toMatchObject({
      agentId: "seo-manager-2",
      openclawWorkspacePath: "~/.openclaw/workspace-seo-manager-2",
      claimedApiKeyPath:
        "~/.openclaw/workspace-seo-manager-2/paperclip-claimed-api-key.json",
    });
  });

  it("leaves non-local invite approval configs unchanged", async () => {
    const adapterConfig = { url: "wss://gateway.example.test/" };
    const svc = openClawGatewayProvisioningService(
      createDbWithOpenClawAgentIds([]) as never,
    );

    const result = await svc.applyLocalOpenClawProvisioningDefaults({
      companyId: "company-1",
      requestedName: "SEO Manager",
      adapterType: "openclaw_gateway",
      adapterConfig,
    });

    expect(result).toBe(adapterConfig);
  });

  it("leaves invite approval configs with existing child agent ids unchanged", async () => {
    const svc = openClawGatewayProvisioningService(
      createDbWithOpenClawAgentIds([]) as never,
    );

    const result = await svc.applyLocalOpenClawProvisioningDefaults({
      companyId: "company-1",
      requestedName: "SEO Manager",
      adapterType: "openclaw_gateway",
      adapterConfig: {
        url: "ws://127.0.0.1:18790/",
        agentId: "existing-child",
        openclawWorkspacePath: "~/.openclaw/custom",
        claimedApiKeyPath: "~/.openclaw/custom/claim.json",
      },
    });

    expect(result).toMatchObject({
      agentId: "existing-child",
      openclawWorkspacePath: "~/.openclaw/custom",
      claimedApiKeyPath: "~/.openclaw/custom/claim.json",
    });
  });

  async function writeCaptureProvisioner(capturePath: string) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-openclaw-provisioner-"));
    const provisionerPath = path.join(dir, "provisioner.mjs");
    await writeFile(
      provisionerPath,
      [
        "#!/usr/bin/env node",
        "import fs from 'node:fs';",
        "const input = fs.readFileSync(0, 'utf8');",
        "fs.writeFileSync(process.env.CAPTURE_PATH, input);",
        "console.log(JSON.stringify({ ok: true }));",
      ].join("\n") + "\n",
      "utf8",
    );
    await chmod(provisionerPath, 0o755);
    process.env.CAPTURE_PATH = capturePath;
    process.env.PAPERCLIP_OPENCLAW_PROVISIONER = provisionerPath;
  }

  it("sends ensure_agent without writing a Paperclip claim", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-openclaw-agent-"));
    const capturePath = path.join(dir, "payload.json");
    await writeCaptureProvisioner(capturePath);

    const svc = openClawGatewayProvisioningService({} as never);
    await svc.ensureOpenClawAgentForAdapterConfigOrThrow({
      url: "ws://127.0.0.1:18790/",
      agentId: "cmo",
      openclawWorkspacePath: "/root/.openclaw/workspace-cmo",
      claimedApiKeyPath: "/root/.openclaw/workspace-cmo/paperclip-claimed-api-key.json",
    });

    const payload = JSON.parse(await readFile(capturePath, "utf8"));
    expect(payload).toMatchObject({
      action: "ensure_agent",
      agentId: "cmo",
      workspacePath: "/root/.openclaw/workspace-cmo",
      claimPath: "/root/.openclaw/workspace-cmo/paperclip-claimed-api-key.json",
    });
    expect(payload).not.toHaveProperty("claim");
    expect(mockAgentService.createApiKey).not.toHaveBeenCalled();
  });

  it("sends a child-specific Paperclip API key claim through the provisioner", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-openclaw-claim-"));
    const capturePath = path.join(dir, "payload.json");
    await writeCaptureProvisioner(capturePath);

    const svc = openClawGatewayProvisioningService({} as never);
    await svc.ensureOpenClawProvisionedForAgentOrThrow({
      id: "paperclip-agent-1",
      adapterType: "openclaw_gateway",
      adapterConfig: {
        url: "ws://localhost:18790/",
        agentId: "cmo",
        openclawWorkspacePath: "/root/.openclaw/workspace-cmo",
        claimedApiKeyPath: "/root/.openclaw/workspace-cmo/paperclip-claimed-api-key.json",
        devicePrivateKeyPem: "child-device-key",
      },
    });

    const payload = JSON.parse(await readFile(capturePath, "utf8"));
    expect(payload).toMatchObject({
      action: "ensure_agent_claim",
      agentId: "cmo",
      paperclipAgentId: "paperclip-agent-1",
      paperclipKeyId: "key-1",
      paperclipApiKey: "pcp_secret_value",
      claim: {
        agentId: "paperclip-agent-1",
        keyId: "key-1",
        token: "pcp_secret_value",
        createdAt: "2026-05-22T00:00:00.000Z",
      },
    });
    expect(payload).not.toHaveProperty("devicePrivateKeyPem");
    expect(mockAgentService.revokeKey).not.toHaveBeenCalled();
  });
});
