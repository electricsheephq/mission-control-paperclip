import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

const API_RATE_LIMIT_WINDOW_MS = 60_000;
const API_RATE_LIMIT_MAX_REQUESTS = 1_800;

function actorRateLimitKey(req: Request): string {
  const actor = req.actor;
  if (actor.type === "board") {
    return `board:${actor.userId ?? actor.keyId ?? actor.source ?? "unknown"}`;
  }
  if (actor.type === "agent") {
    return `agent:${actor.agentId ?? actor.keyId ?? "unknown"}`;
  }
  return `ip:${ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown")}`;
}

export function createApiRateLimiter() {
  return rateLimit({
    windowMs: API_RATE_LIMIT_WINDOW_MS,
    limit: API_RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: actorRateLimitKey,
    skip: (req) => req.method === "GET" && req.path === "/health",
  });
}
