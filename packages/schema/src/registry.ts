import { defineSyncRegistry, type JwtClaims } from "@pgxsinkit/contracts";

import { authorsSyncEntry, todosSyncEntry } from "./schema";

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function isAdmin(claims: JwtClaims): boolean {
  return claims.app_metadata?.roles?.includes("admin") ?? false;
}

function ownershipRowFilter(claims: JwtClaims): string | null {
  if (isAdmin(claims)) {
    return null;
  }

  if (claims.sub) {
    return `"owner_id" = '${escapeSqlLiteral(claims.sub)}'`;
  }

  return "1 = 0";
}

export const demoSyncRegistry = defineSyncRegistry({
  authors: {
    ...authorsSyncEntry,
    shape: { ...authorsSyncEntry.shape!, rowFilter: { customWhere: ownershipRowFilter } },
  },
  todos: {
    ...todosSyncEntry,
    shape: { ...todosSyncEntry.shape!, rowFilter: { customWhere: ownershipRowFilter } },
  },
});
