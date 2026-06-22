import { describe, expect, it } from "bun:test";

import {
  escapeSqlLiteral,
  isReservedKeyword,
  isSimpleIdentifier,
  maybeQuoteIdentifier,
  quoteIdentifier,
  quoteSqlLiteral,
} from "@pgxsinkit/contracts";

// The single SQL identifier/literal resolver every package now routes through
// (ADR-0004). Previously five-plus copies disagreed; the mutation path even left
// reserved-word table names unquoted. These pin the one definition.

describe("sql identifier resolver (ADR-0004)", () => {
  it("always quotes identifiers and doubles embedded quotes", () => {
    expect(quoteIdentifier("owner_id")).toBe(`"owner_id"`);
    expect(quoteIdentifier(`a"b`)).toBe(`"a""b"`);
  });

  it("recognises bare-safe simple identifiers (lowercase only)", () => {
    expect(isSimpleIdentifier("todos")).toBe(true);
    expect(isSimpleIdentifier("_x1")).toBe(true);
    // Uppercase would be folded to lowercase by Postgres, so it is not bare-safe.
    expect(isSimpleIdentifier("Todos")).toBe(false);
    expect(isSimpleIdentifier("with space")).toBe(false);
  });

  it("flags reserved keywords", () => {
    expect(isReservedKeyword("group")).toBe(true);
    expect(isReservedKeyword("order")).toBe(true);
    expect(isReservedKeyword("todos")).toBe(false);
  });

  it("leaves simple non-reserved names bare and quotes the rest", () => {
    expect(maybeQuoteIdentifier("todos")).toBe("todos");
    // The regression: a reserved-word table name must be quoted, not emitted bare.
    expect(maybeQuoteIdentifier("group")).toBe(`"group"`);
    expect(maybeQuoteIdentifier("Todos")).toBe(`"Todos"`);
  });

  it("escapes and quotes string literals", () => {
    expect(escapeSqlLiteral("x' OR '1'='1")).toBe("x'' OR ''1''=''1");
    expect(quoteSqlLiteral("a'b")).toBe("'a''b'");
  });
});
