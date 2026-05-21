import { logger } from "../middleware/logger.js";

const AGENT_START_LOCK_STALE_MS = 30_000;
const startLocksByAgent = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

async function waitForStartLock(
  lockKey: string,
  lock: { promise: Promise<void>; startedAtMs: number },
  logContext: Record<string, unknown>,
) {
  const elapsedMs = Date.now() - lock.startedAtMs;
  const remainingMs = AGENT_START_LOCK_STALE_MS - elapsedMs;
  if (remainingMs <= 0) {
    logger.warn({ ...logContext, lockKey, staleMs: elapsedMs }, "start lock stale; continuing queued-run start");
    return;
  }

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    lock.promise,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, remainingMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (timedOut) {
    logger.warn({ ...logContext, lockKey, staleMs: AGENT_START_LOCK_STALE_MS }, "start lock timed out; continuing queued-run start");
  }
}

export async function withStartLock<T>(
  lockKey: string,
  fn: () => Promise<T>,
  logContext: Record<string, unknown> = {},
) {
  const previous = startLocksByAgent.get(lockKey);
  const waitForPrevious = previous ? waitForStartLock(lockKey, previous, logContext) : Promise.resolve();
  const run = waitForPrevious.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(lockKey, { promise: marker, startedAtMs: Date.now() });
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(lockKey)?.promise === marker) {
      startLocksByAgent.delete(lockKey);
    }
  }
}

export async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  return withStartLock(`agent:${agentId}`, fn, { agentId });
}
