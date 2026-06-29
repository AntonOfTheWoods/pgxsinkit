import { describe, expect, it } from "bun:test";

import { sql } from "drizzle-orm";
import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { generateLocalSchemaSql } from "@pgxsinkit/client";
import {
  asReadonly,
  assertReadContractPreserved,
  c,
  defineSyncRegistry,
  defineSyncTable,
  fingerprintReadContract,
  fingerprintRegistry,
} from "@pgxsinkit/contracts";

// Per-client mode projection: the authoritative (server) registry defines a table once with its full
// write contract; a client that must not write it consumes the same table through `asReadonly`. The
// read/identity contract is preserved; only the write capability (and its local machinery) is dropped.

// A writable table mirroring the authoritative definition: full write contract (conflictPolicy +
// nowMicroseconds server-version + managed fields) plus a per-identity row filter with a revision tag.
const writableRestriction = () =>
  defineSyncTable({
    tableName: "posting_restriction",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      offeringId: uuid("offering_id").notNull(),
      personId: uuid("person_id").notNull(),
      issuedBy: uuid("issued_by"),
      reason: varchar("reason", { length: 200 }),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" })
        .notNull()
        .default(sql`0`),
    }),
    mode: "readwrite",
    conflictPolicy: "reject-if-stale",
    governance: {
      managedFields: [
        { column: "issuedBy", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] },
        { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
      ],
    },
    shape: {
      rowFilter: (columns) => ({
        customWhere: (claims) => (claims.sub ? sql`${c(columns.personId)} = ${claims.sub}` : null),
        revision: "v1",
      }),
    },
  });

const readonlyOffering = () =>
  defineSyncTable({
    tableName: "offering",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
    }),
  });

describe("asReadonly (readonly projection)", () => {
  it("flips mode to readonly and drops the write machinery", () => {
    const rw = writableRestriction();
    const ro = asReadonly(rw);

    expect(rw.mode).toBe("readwrite");
    expect(ro.mode).toBe("readonly");

    // The readwrite entry carries the overlay-merged read-model view + overlay/journal projection;
    // the readonly projection has none of them (its read path hits the synced base table directly).
    expect(rw.view).toBeDefined();
    expect(ro.view).toBeUndefined();
    expect(rw.clientProjection?.overlayTable).toBe("posting_restriction_overlay");
    expect(rw.clientProjection?.journalTable).toBe("posting_restriction_mutations");
    expect(ro.clientProjection?.overlayTable).toBeUndefined();
    expect(ro.clientProjection?.journalTable).toBeUndefined();

    // Write-only governance is stripped — a readonly table has no write path.
    expect(ro.conflictPolicy).toBeUndefined();
    expect(ro.governance).toBeUndefined();
  });

  it("preserves the synced table, columns, primary key and shape", () => {
    const rw = writableRestriction();
    const ro = asReadonly(rw);

    expect(ro.table).toBe(rw.table);
    expect(ro.localTable).toBe(rw.localTable);
    expect(ro.primaryKey).toEqual(rw.primaryKey);
    expect(ro.clientProjection?.syncedTable).toBe(rw.clientProjection?.syncedTable);
    expect(ro.shape).toEqual(rw.shape);
  });

  it("yields an entry a registry accepts as readonly (no conflictPolicy / server-version required)", () => {
    // The writable source would throw without conflictPolicy; its readonly projection has no such need.
    expect(() => defineSyncRegistry({ posting_restriction: asReadonly(writableRestriction()) })).not.toThrow();
  });

  it("emits no overlay/journal DDL for the readonly projection (client schema gen)", () => {
    const rwSql = generateLocalSchemaSql(defineSyncRegistry({ posting_restriction: writableRestriction() }));
    const roSql = generateLocalSchemaSql(
      defineSyncRegistry({ posting_restriction: asReadonly(writableRestriction()) }),
    );

    // The writable client provisions the full write cluster.
    expect(rwSql).toContain("posting_restriction_overlay");
    expect(rwSql).toContain("posting_restriction_mutations");

    // The readonly client provisions only the synced base table.
    expect(roSql).toContain("posting_restriction");
    expect(roSql).not.toContain("posting_restriction_overlay");
    expect(roSql).not.toContain("posting_restriction_mutations");
  });
});

describe("read-contract fingerprint", () => {
  it("is identical for a writable entry and its readonly projection", () => {
    const rw = writableRestriction();
    expect(fingerprintReadContract(asReadonly(rw))).toBe(fingerprintReadContract(rw));
  });

  it("ignores write-only differences (conflict policy, managed fields, mode)", () => {
    const reject = writableRestriction();
    const lww = defineSyncTable({
      tableName: "posting_restriction",
      makeColumns: () => ({
        id: uuid("id").primaryKey(),
        offeringId: uuid("offering_id").notNull(),
        personId: uuid("person_id").notNull(),
        issuedBy: uuid("issued_by"),
        reason: varchar("reason", { length: 200 }),
        updatedAtUs: bigint("updated_at_us", { mode: "bigint" })
          .notNull()
          .default(sql`0`),
      }),
      mode: "readwrite",
      conflictPolicy: "last-write-wins",
      governance: {
        managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
      },
      shape: {
        rowFilter: (columns) => ({
          customWhere: (claims) => (claims.sub ? sql`${c(columns.personId)} = ${claims.sub}` : null),
          revision: "v1",
        }),
      },
    });

    expect(fingerprintReadContract(lww)).toBe(fingerprintReadContract(reject));
  });

  it("changes when a synced column changes", () => {
    const widened = defineSyncTable({
      tableName: "posting_restriction",
      makeColumns: () => ({
        id: uuid("id").primaryKey(),
        offeringId: uuid("offering_id").notNull(),
        personId: uuid("person_id").notNull(),
        issuedBy: uuid("issued_by"),
        reason: varchar("reason", { length: 200 }),
        note: varchar("note", { length: 200 }),
        updatedAtUs: bigint("updated_at_us", { mode: "bigint" })
          .notNull()
          .default(sql`0`),
      }),
      mode: "readwrite",
      conflictPolicy: "reject-if-stale",
      governance: {
        managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
      },
    });

    expect(fingerprintReadContract(widened)).not.toBe(fingerprintReadContract(writableRestriction()));
  });

  it("changes when the row-filter revision is bumped", () => {
    const base = writableRestriction();
    const bumped = { ...base, shape: { ...base.shape!, rowFilter: { ...base.shape!.rowFilter!, revision: "v2" } } };
    expect(fingerprintReadContract(bumped)).not.toBe(fingerprintReadContract(base));
  });

  it("documents that the FULL registry fingerprint DOES differ (the two clients have different local stores)", () => {
    expect(fingerprintRegistry(defineSyncRegistry({ posting_restriction: writableRestriction() }))).not.toBe(
      fingerprintRegistry(defineSyncRegistry({ posting_restriction: asReadonly(writableRestriction()) })),
    );
  });
});

describe("assertReadContractPreserved (projection invariant)", () => {
  const authoritative = defineSyncRegistry({
    posting_restriction: writableRestriction(),
    offering: readonlyOffering(),
  });

  it("passes when a projection is asReadonly of the authoritative entry (and a subset is fine)", () => {
    const learner = defineSyncRegistry({ posting_restriction: asReadonly(writableRestriction()) });
    expect(() => assertReadContractPreserved(authoritative, learner)).not.toThrow();
  });

  it("throws, naming the table, when a projection diverges the synced data shape", () => {
    const divergent = defineSyncRegistry({
      posting_restriction: defineSyncTable({
        tableName: "posting_restriction",
        makeColumns: () => ({ id: uuid("id").primaryKey() }),
      }),
    });
    expect(() => assertReadContractPreserved(authoritative, divergent)).toThrow(/posting_restriction/);
  });

  it("throws when a projected table is absent from the authoritative registry", () => {
    const orphan = defineSyncRegistry({ ghost: readonlyOffering() });
    expect(() => assertReadContractPreserved(authoritative, orphan)).toThrow(/ghost/);
  });
});
