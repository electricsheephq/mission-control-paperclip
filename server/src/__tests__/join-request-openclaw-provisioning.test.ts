import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "company-1";
const requestId = "join-1";
const inviteId = "invite-1";
const managerId = "agent-manager-1";
const childAgentId = "agent-child-1";

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  isInstanceAdmin: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalGrants: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

const mockBoardAuthService = vi.hoisted(() => ({
  createChallenge: vi.fn(),
  resolveBoardAccess: vi.fn(),
  assertCurrentBoardKey: vi.fn(),
  revokeBoardApiKey: vi.fn(),
}));

const mockDeduplicateAgentName = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockNotifyHireApproved = vi.hoisted(() => vi.fn());
const mockOpenClawProvisioning = vi.hoisted(() => ({
  applyLocalOpenClawProvisioningDefaults: vi.fn(),
  ensureOpenClawAgentForAdapterConfigOrThrow: vi.fn(),
  ensureOpenClawProvisionedForAgentOrThrow: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    boardAuthService: () => mockBoardAuthService,
    deduplicateAgentName: mockDeduplicateAgentName,
    logActivity: mockLogActivity,
    notifyHireApproved: mockNotifyHireApproved,
  }));
  vi.doMock("../services/openclaw-gateway-provisioning.js", () => ({
    openClawGatewayProvisioningService: () => mockOpenClawProvisioning,
  }));
}

const invite = {
  id: inviteId,
  companyId,
  defaultsPayload: null,
};

const managerAgent = {
  id: managerId,
  companyId,
  name: "CEO",
  role: "ceo",
  reportsTo: null,
  status: "idle",
  adapterType: "openclaw_gateway",
  adapterConfig: { agentId: "main" },
};

function createJoinRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: requestId,
    companyId,
    inviteId,
    status: "pending_approval",
    requestType: "agent",
    requestingUserId: null,
    agentName: "Sales Systems Builder",
    capabilities: null,
    adapterType: "openclaw_gateway",
    agentDefaultsPayload: {
      url: "ws://127.0.0.1:18790",
      headers: { "x-openclaw-token": "gateway-token" },
    },
    createdAgentId: null,
    claimSecretHash: "hidden",
    createdAt: new Date("2026-05-27T00:00:00.000Z"),
    updatedAt: new Date("2026-05-27T00:00:00.000Z"),
    ...overrides,
  };
}

function createOpenClawAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: childAgentId,
    companyId,
    name: "Sales Systems Builder",
    role: "general",
    reportsTo: managerId,
    status: "idle",
    pauseReason: null,
    adapterType: "openclaw_gateway",
    adapterConfig: {
      url: "ws://127.0.0.1:18790",
      headers: { "x-openclaw-token": "gateway-token" },
      agentId: "sales-systems-builder",
      openclawWorkspacePath: "~/.openclaw/workspace-sales-systems-builder",
      claimedApiKeyPath:
        "~/.openclaw/workspace-sales-systems-builder/paperclip-claimed-api-key.json",
    },
    ...overrides,
  };
}

function createDbStub(joinRequest: Record<string, unknown>) {
  const selectResults = [[joinRequest], [invite]];
  const updateCalls: Array<Record<string, unknown>> = [];

  function makeUpdateQuery(values: Record<string, unknown>) {
    const rows = [{ ...joinRequest, ...values }];
    const promise = Promise.resolve(rows);
    return {
      returning: vi.fn(() => ({
        then: vi.fn((resolve) => promise.then(resolve)),
      })),
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
    };
  }

  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            then: vi.fn((resolve) => Promise.resolve(resolve(selectResults.shift() ?? []))),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updateCalls.push(values);
          return {
            where: vi.fn(() => makeUpdateQuery(values)),
          };
        }),
      })),
    },
    updateCalls,
  };
}

async function createApp(db: unknown) {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/access.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "local_implicit",
      userId: null,
      companyIds: [companyId],
    };
    next();
  });
  app.use(
    "/api",
    accessRoutes(db as never, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("OpenClaw Gateway join request approval provisioning", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/openclaw-gateway-provisioning.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();

    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.isInstanceAdmin.mockResolvedValue(true);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalGrants.mockResolvedValue(undefined);
    mockAgentService.list.mockResolvedValue([managerAgent]);
    mockAgentService.getById.mockResolvedValue(createOpenClawAgent());
    mockAgentService.create.mockResolvedValue(createOpenClawAgent());
    mockAgentService.update.mockResolvedValue(createOpenClawAgent({ status: "paused" }));
    mockDeduplicateAgentName.mockImplementation((name) => name);
    mockLogActivity.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
    mockOpenClawProvisioning.applyLocalOpenClawProvisioningDefaults.mockImplementation(async (input) => ({
      ...input.adapterConfig,
      agentId: "sales-systems-builder",
      openclawWorkspacePath: "~/.openclaw/workspace-sales-systems-builder",
      claimedApiKeyPath:
        "~/.openclaw/workspace-sales-systems-builder/paperclip-claimed-api-key.json",
    }));
    mockOpenClawProvisioning.ensureOpenClawAgentForAdapterConfigOrThrow.mockResolvedValue(undefined);
    mockOpenClawProvisioning.ensureOpenClawProvisionedForAgentOrThrow.mockResolvedValue(undefined);
  });

  it("pauses a created Paperclip agent and leaves the join retryable when claim provisioning fails", async () => {
    const { unprocessable } = await import("../errors.js");
    const dbStub = createDbStub(createJoinRequest());
    mockOpenClawProvisioning.ensureOpenClawProvisionedForAgentOrThrow.mockRejectedValue(
      unprocessable("claim file failed"),
    );
    const app = await createApp(dbStub.db);

    const res = await request(app)
      .post(`/api/companies/${companyId}/join-requests/${requestId}/approve`)
      .send({});

    expect(res.status).toBe(422);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      childAgentId,
      expect.objectContaining({
        status: "paused",
        pauseReason: expect.stringContaining("OpenClaw provisioning failed"),
      }),
    );
    expect(dbStub.updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ createdAgentId: childAgentId }),
      ]),
    );
    expect(dbStub.updateCalls.some((call) => call.status === "approved")).toBe(false);
    expect(mockLogActivity).toHaveBeenCalledWith(
      dbStub.db,
      expect.objectContaining({
        action: "agent.paused",
        entityId: childAgentId,
        details: expect.objectContaining({
          reason: "openclaw_provisioning_failed",
          source: "join_request",
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      dbStub.db,
      expect.objectContaining({
        action: "join.provisioning_failed",
        entityId: requestId,
        details: expect.objectContaining({
          phase: "ensure_claim",
          createdAgentId: childAgentId,
        }),
      }),
    );
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("reuses and resumes a previously paused join-created agent on approval retry", async () => {
    const dbStub = createDbStub(createJoinRequest({ createdAgentId: childAgentId }));
    mockAgentService.getById.mockResolvedValue(
      createOpenClawAgent({
        status: "paused",
        pauseReason: "OpenClaw provisioning failed: claim file failed",
      }),
    );
    mockAgentService.update.mockResolvedValue(createOpenClawAgent({ status: "idle" }));
    const app = await createApp(dbStub.db);

    const res = await request(app)
      .post(`/api/companies/${companyId}/join-requests/${requestId}/approve`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockOpenClawProvisioning.ensureOpenClawProvisionedForAgentOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ id: childAgentId }),
    );
    expect(mockAgentService.update).toHaveBeenCalledWith(
      childAgentId,
      expect.objectContaining({
        status: "idle",
        pauseReason: null,
        pausedAt: null,
      }),
    );
    expect(dbStub.updateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "approved",
          createdAgentId: childAgentId,
        }),
      ]),
    );
    expect(mockAccessService.ensureMembership).toHaveBeenCalledWith(
      companyId,
      "agent",
      childAgentId,
      "member",
      "active",
    );
    expect(mockNotifyHireApproved).toHaveBeenCalledWith(
      dbStub.db,
      expect.objectContaining({ agentId: childAgentId, source: "join_request" }),
    );
  });
});
