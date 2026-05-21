import { describe, expect, it } from "vitest";
import { buildWakeText, resolveClaimedApiKeyPath, resolveSessionKey } from "./execute.js";

describe("resolveSessionKey", () => {
  it("prefixes run-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "run",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip:run:run-123");
  });

  it("prefixes issue-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: "issue-456",
      }),
    ).toBe("agent:meridian:paperclip:issue:issue-456");
  });

  it("prefixes fixed session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("does not double-prefix an already-routed session key", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "agent:meridian:paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });
});

describe("resolveClaimedApiKeyPath", () => {
  it("falls back to the main OpenClaw workspace claim file", () => {
    expect(resolveClaimedApiKeyPath("")).toBe("~/.openclaw/workspace/paperclip-claimed-api-key.json");
  });

  it("honors an explicit per-agent claim file path", () => {
    expect(resolveClaimedApiKeyPath("~/.openclaw/workspace-cmo/paperclip-claimed-api-key.json"))
      .toBe("~/.openclaw/workspace-cmo/paperclip-claimed-api-key.json");
  });
});

describe("buildWakeText", () => {
  it("tells OpenClaw to load the configured claimed API key path", () => {
    const text = buildWakeText(
      {
        runId: "run-123",
        agentId: "agent-123",
        companyId: "company-123",
        taskId: null,
        issueId: "issue-123",
        issueIds: ["issue-123"],
        wakeReason: "issue_assigned",
        wakeCommentId: null,
        approvalId: null,
        approvalStatus: null,
      },
      {
        PAPERCLIP_RUN_ID: "run-123",
        PAPERCLIP_AGENT_ID: "agent-123",
        PAPERCLIP_COMPANY_ID: "company-123",
        PAPERCLIP_API_URL: "http://127.0.0.1:3100",
      },
      "",
      "~/.openclaw/workspace-cmo/paperclip-claimed-api-key.json",
    );

    expect(text).toContain(
      "PAPERCLIP_API_KEY=<token from ~/.openclaw/workspace-cmo/paperclip-claimed-api-key.json>",
    );
    expect(text).toContain(
      "Load PAPERCLIP_API_KEY from ~/.openclaw/workspace-cmo/paperclip-claimed-api-key.json",
    );
  });
});
