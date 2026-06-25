// Opt-in runtime instrumentation for diagnosing convergence / sync latency in a live app (e.g. the
// board demo). It is OFF by default and adds nothing to a normal run: every call early-returns unless
// `globalThis.__pgxsinkitDebug` is truthy, so it is safe to leave the call sites in shipping code.
//
// Enable it from the browser console (`globalThis.__pgxsinkitDebug = true`) — or set it before the
// client boots; the board's dev build turns it on automatically. Each line is stamped with a monotonic
// millisecond clock so the gaps between phases (enqueue → flush → server ack → Electric echo →
// overlay clear → live-query render) can be read straight off the console.

interface DebugGlobal {
  __pgxsinkitDebug?: boolean;
}

const isEnabled = (): boolean => (globalThis as DebugGlobal).__pgxsinkitDebug === true;

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Log one timestamped event. No-op unless `globalThis.__pgxsinkitDebug` is on. */
export function syncDebug(event: string, data?: Record<string, unknown>): void {
  if (!isEnabled()) return;
  const stamp = `[pgxsinkit ${now().toFixed(0)}ms]`;
  if (data) {
    console.debug(`${stamp} ${event}`, data);
  } else {
    console.debug(`${stamp} ${event}`);
  }
}

/**
 * Run `fn`, logging `<event> done` with its wall-clock duration (and any extra `data`). When
 * instrumentation is off this is a thin pass-through with no logging and no timing overhead beyond the
 * call itself. Returns whatever `fn` returns.
 */
export async function timeAsync<T>(event: string, fn: () => Promise<T>, data?: Record<string, unknown>): Promise<T> {
  if (!isEnabled()) return fn();
  const startedAt = now();
  syncDebug(`${event} start`, data);
  try {
    return await fn();
  } finally {
    syncDebug(`${event} done`, { ms: Math.round(now() - startedAt) });
  }
}
