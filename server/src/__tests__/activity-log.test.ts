import { beforeEach, describe, expect, it, vi } from "vitest";
import { logActivity } from "../services/activity-log.js";

const publishLiveEventMock = vi.hoisted(() => vi.fn());
const getGeneralMock = vi.hoisted(() => vi.fn());

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: publishLiveEventMock,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: getGeneralMock,
  }),
}));

function dbWithInsertValues(values: ReturnType<typeof vi.fn>) {
  return {
    insert: vi.fn(() => ({ values })),
  };
}

describe("logActivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGeneralMock.mockResolvedValue({ censorUsernameInLogs: false });
  });

  it("retries without run id when activity_log rejects a stale heartbeat run reference", async () => {
    const runId = "33333333-3333-4333-8333-333333333333";
    const values = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(
        new Error("violates foreign key constraint activity_log_run_id_heartbeat_runs_id_fk"),
        {
          code: "23503",
          constraint: "activity_log_run_id_heartbeat_runs_id_fk",
        },
      ))
      .mockResolvedValueOnce(undefined);

    await logActivity(dbWithInsertValues(values) as any, {
      companyId: "company-1",
      actorType: "agent",
      actorId: "agent-1",
      action: "agent.hire_created",
      entityType: "agent",
      entityId: "child-agent-1",
      agentId: "agent-1",
      runId,
      details: { name: "CMO" },
    });

    expect(values).toHaveBeenCalledTimes(2);
    expect(values.mock.calls[0]?.[0]).toMatchObject({ runId });
    expect(values.mock.calls[1]?.[0]).toMatchObject({ runId: null });
    expect(publishLiveEventMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ runId: null }),
    }));
  });

  it("does not retry unrelated activity log insert failures", async () => {
    const values = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(
        new Error("violates foreign key constraint activity_log_company_id_companies_id_fk"),
        {
          code: "23503",
          constraint: "activity_log_company_id_companies_id_fk",
        },
      ));

    await expect(logActivity(dbWithInsertValues(values) as any, {
      companyId: "company-1",
      actorType: "agent",
      actorId: "agent-1",
      action: "agent.hire_created",
      entityType: "agent",
      entityId: "child-agent-1",
      agentId: "agent-1",
      runId: "33333333-3333-4333-8333-333333333333",
    })).rejects.toThrow("activity_log_company_id_companies_id_fk");

    expect(values).toHaveBeenCalledTimes(1);
    expect(publishLiveEventMock).not.toHaveBeenCalled();
  });

  it("does not retry generic UUID projection failures unless they identify run_id", async () => {
    const values = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(
        new Error("invalid input syntax for type uuid"),
        {
          code: "22P02",
        },
      ));

    await expect(logActivity(dbWithInsertValues(values) as any, {
      companyId: "company-1",
      actorType: "agent",
      actorId: "agent-1",
      action: "agent.hire_created",
      entityType: "agent",
      entityId: "child-agent-1",
      agentId: "agent-1",
      runId: "33333333-3333-4333-8333-333333333333",
    })).rejects.toThrow("invalid input syntax for type uuid");

    expect(values).toHaveBeenCalledTimes(1);
    expect(publishLiveEventMock).not.toHaveBeenCalled();
  });
});
