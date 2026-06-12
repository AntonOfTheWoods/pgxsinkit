import {
  buildRowFilterWhere,
  getOmittedProjectedColumnNames,
  type JwtClaims,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

export interface ElectricProxyOptions {
  registry: SyncTableRegistry;
  electricUrl: string;
  /** Extra params passed to customWhere functions (e.g. fromLang, toLang). */
  extraParams?: Record<string, unknown>;
}

/**
 * Proxies an Electric shape request, applying registry-driven row filters
 * and stripping omitted columns from JSON shape-log payloads.
 *
 * The caller is responsible for resolving auth claims from the request.
 * Pass `claims` as `null` for unauthenticated requests (all rows blocked).
 */
export async function proxyElectricShapeRequest(
  request: Request,
  claims: JwtClaims | null,
  options: ElectricProxyOptions,
): Promise<Response> {
  const targetUrl = buildProxyTargetUrl(request, claims, options);

  const response = await fetch(targetUrl.toString(), {
    method: "GET",
    signal: request.signal,
  }).catch((error: unknown) => {
    if (isAbortError(error)) {
      // Client disconnected — no meaningful response can be sent.
      // Return a 499 (client closed request) to avoid a 500 in logs.
      return new Response(null, { status: 499, statusText: "Client Closed Request" });
    }
    throw error;
  });

  const responseHeaders = new Headers(response.headers);
  // Strip encoding/length since the response body may be re-serialized
  // (column omission path) or streamed through a new Response object.
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");

  const table = new URL(request.url).searchParams.get("table");
  const omittedColumns = table ? getOmittedProjectedColumnsForTable(options.registry, table) : [];
  const contentType = responseHeaders.get("content-type") ?? "";

  if (omittedColumns.length > 0 && contentType.includes("application/json")) {
    const payload = await response
      .clone()
      .json()
      .catch(() => undefined);

    if (Array.isArray(payload)) {
      const stripped = stripOmittedColumnsFromShapeLogEntries(payload, omittedColumns);
      return new Response(JSON.stringify(stripped), {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

function buildProxyTargetUrl(request: Request, claims: JwtClaims | null, options: ElectricProxyOptions): string {
  const requestUrl = new URL(request.url);
  const targetUrl = new URL(options.electricUrl);

  // Merge incoming request params into the electric URL, preserving
  // any pre-existing params (e.g. secret API token from electricUrl).
  requestUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.set(key, value);
  });

  const table = targetUrl.searchParams.get("table");

  if (!table) {
    return targetUrl.toString();
  }

  const entry = getRegistryEntry(options.registry, table);

  if (!entry) {
    return targetUrl.toString();
  }

  const rowFilter = entry.shape?.rowFilter;

  if (!rowFilter) {
    return targetUrl.toString();
  }

  const whereClause = buildRowFilterWhere(rowFilter, claims, options.extraParams);

  if (!whereClause) {
    return targetUrl.toString();
  }

  const existingWhere = targetUrl.searchParams.get("where");

  if (!existingWhere) {
    targetUrl.searchParams.set("where", whereClause);
  } else {
    targetUrl.searchParams.set("where", `(${existingWhere}) AND (${whereClause})`);
  }

  // Apply column projection from registry if configured
  if (rowFilter.columns && rowFilter.columns.length > 0) {
    targetUrl.searchParams.set("columns", rowFilter.columns.join(","));
  }

  return targetUrl.toString();
}

function getRegistryEntry(registry: SyncTableRegistry, table: string) {
  // Table names may be qualified (schema.table) — normalize to just the table name
  const parts = table.split(".");
  const key = parts.at(-1) ?? table;
  return registry[key as keyof typeof registry];
}

function getOmittedProjectedColumnsForTable(registry: SyncTableRegistry, table: string): readonly string[] {
  const entry = getRegistryEntry(registry, table);
  return entry ? getOmittedProjectedColumnNames(entry) : [];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Subset of an Electric shape-log entry the proxy rewrites: `value` carries the
 * row, `old_value` the prior row on updates. Runtime guards still validate both
 * before use; the declared shape is the wire-protocol expectation.
 */
interface ShapeLogEntry {
  value?: Record<string, unknown>;
  old_value?: Record<string, unknown>;
  [key: string]: unknown;
}

function isShapeLogEntry(value: unknown): value is ShapeLogEntry {
  return isObjectRecord(value);
}

function stripOmittedColumnsFromShapeLogEntries(payload: unknown[], omittedColumns: readonly string[]): unknown[] {
  return payload.map((entry) => {
    if (!isShapeLogEntry(entry)) {
      return entry;
    }

    let nextEntry: ShapeLogEntry | null = null;

    if (isObjectRecord(entry.value)) {
      const nextValue = omitColumnsFromRow(entry.value, omittedColumns);
      if (nextValue !== entry.value) {
        nextEntry = { ...entry, value: nextValue };
      }
    }

    const currentEntry = nextEntry ?? entry;
    if (isObjectRecord(currentEntry.old_value)) {
      const nextOldValue = omitColumnsFromRow(currentEntry.old_value, omittedColumns);
      if (nextOldValue !== currentEntry.old_value) {
        return { ...currentEntry, old_value: nextOldValue };
      }
    }

    return currentEntry;
  });
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      // Bun wraps aborted fetch as DOMException with numeric code
      (typeof (error as unknown as { code?: unknown }).code === "number" &&
        (error as unknown as { code: number }).code === 20))
  );
}

function omitColumnsFromRow(row: Record<string, unknown>, omittedColumns: readonly string[]): Record<string, unknown> {
  let changed = false;
  const nextRow = { ...row };

  for (const column of omittedColumns) {
    if (Object.prototype.hasOwnProperty.call(nextRow, column)) {
      delete nextRow[column];
      changed = true;
    }
  }

  return changed ? nextRow : row;
}
