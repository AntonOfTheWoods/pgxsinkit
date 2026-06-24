import type { ExternalHeadersRecord, ShapeStreamOptions } from "@electric-sql/client";

/** The per-shape error handler shape Electric expects (`ShapeStreamOptions.onError`). */
type ShapeStreamErrorHandler = NonNullable<ShapeStreamOptions["onError"]>;

/**
 * Read-path identity (ADR-0013). The two ingress points must share **one** token lifecycle: the
 * write path already calls `getAuthToken` fresh on every flush, so the read path must too — never
 * freezing a JWT at boot, which wedges a long-lived offline-first session the instant the token
 * expires.
 *
 * `buildAuthShapeHeaders` returns the read-path `Authorization` header as an **async function**.
 * Electric resolves header-value functions on every request *and every retry*
 * (`ExternalHeadersRecord` allows `string | (() => string | Promise<string>)`), so each shape fetch
 * presents a fresh token. This is the client mirror of ADR-0003's server-side one-identity decision.
 *
 * The provider contract (documented in `docs/architecture.md`): `getAuthToken` is now called per
 * request by both paths and **must be refresh-deduping** — return the cached valid token and refresh
 * single-flight, so an N-shape consistency group does not trigger N refreshes.
 */
export function buildAuthShapeHeaders(getAuthToken: () => Promise<string | undefined>): ExternalHeadersRecord {
  return {
    // Resolved per request: a fresh token each time, never one captured at boot. An absent token
    // yields an empty value (unauthenticated) rather than the literal string `Bearer undefined`.
    Authorization: async () => {
      const token = await getAuthToken();
      return token ? `Bearer ${token}` : "";
    },
  };
}

/** HTTP statuses that mean "the credential is the problem" — re-auth, never give up (ADR-0013). */
const AUTH_ERROR_STATUSES = new Set([401, 403]);

/**
 * True when the error is an auth failure (Electric's `FetchError` with a 401/403 `status`). We read
 * the documented `status` field rather than `instanceof FetchError`: the experimental and client
 * packages can resolve to *different* `@electric-sql/client` copies, so an `instanceof` against one
 * copy can miss a `FetchError` thrown from the other. A duck-typed numeric `status` is robust and
 * carries no false positives — a plain network/`Error` has no numeric `status`.
 */
function isAuthError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return false;
  }
  const status = (error as { status: unknown }).status;
  return typeof status === "number" && AUTH_ERROR_STATUSES.has(status);
}

/**
 * The per-shape `ShapeStreamOptions.onError` handler that recovers the read path from auth errors
 * (ADR-0013 Phase 2/3). Electric auto-retries network / 5xx / 429 with backoff, but **not** 4xx —
 * including 401/403 — so without this a token expiry permanently stops the read stream.
 *
 * On a 401/403 it returns `{}` (retry): Electric re-issues the request, re-resolving the async
 * Authorization header ({@link buildAuthShapeHeaders}) for a *fresh* token. It must **never** return
 * `void` for an auth error — `void` stops the stream permanently, which is wrong for offline-first:
 * a dead session must keep retrying (Electric's jittered backoff bounds the cost) so sync resumes
 * automatically the instant re-authentication makes the token valid again. The optional
 * `onAuthError` notification lets the runtime surface a distinct "re-login" status (decision 3).
 *
 * Every other error (a genuine non-auth 4xx, or 5xx after Electric exhausted its own retries) falls
 * through to `undefined` — the engine's default stop — and is surfaced via the stream's subscribe
 * `onError`. This is the per-shape `onError` (which alone can request a retry), **not** the
 * `MultiShapeStream.subscribe` `onError`, which is notification-only and cannot return retry opts.
 */
export function createShapeAuthErrorHandler(options: { onAuthError?: () => void } = {}): ShapeStreamErrorHandler {
  return (error: Error) => {
    if (isAuthError(error)) {
      options.onAuthError?.();
      return {}; // retry → re-resolves the async Authorization header for a fresh token
    }
    return undefined; // non-auth error: stop (engine default), surfaced via the subscribe onError
  };
}
