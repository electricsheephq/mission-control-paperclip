import {
  AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
  OPENCLAW_GATEWAY_DEFAULT_MAX_CONCURRENT_RUNS,
} from "@paperclipai/shared";
import { defaultCreateValues } from "../components/agent-config-defaults";

export function buildNewAgentRuntimeConfig(input?: {
  adapterType?: string;
  heartbeatEnabled?: boolean;
  intervalSec?: number;
  cheapModel?: string;
  cheapModelEnabled?: boolean;
}): Record<string, unknown> {
  const maxConcurrentRuns = input?.adapterType === "openclaw_gateway"
    ? OPENCLAW_GATEWAY_DEFAULT_MAX_CONCURRENT_RUNS
    : AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
  const config: Record<string, unknown> = {
    heartbeat: {
      enabled: input?.heartbeatEnabled ?? defaultCreateValues.heartbeatEnabled,
      intervalSec: input?.intervalSec ?? defaultCreateValues.intervalSec,
      wakeOnDemand: true,
      cooldownSec: 10,
      maxConcurrentRuns,
    },
  };

  const cheapModel = input?.cheapModel?.trim() ?? "";
  const cheapEnabled = input?.cheapModelEnabled ?? false;
  if (cheapModel && cheapEnabled) {
    config.modelProfiles = {
      cheap: {
        enabled: true,
        adapterConfig: { model: cheapModel },
      },
    };
  }

  return config;
}
