import { describe, expect, it } from "bun:test";

import {
  assertValidMutationTransition,
  classifyFailureStatus,
  DEFAULT_MAX_MUTATION_ATTEMPTS,
  isValidMutationTransition,
  MUTATION_TRANSITIONS,
} from "../../packages/client/src/mutation-state";

// The one named definition of the mutation-journal transitions (ADR-0005, ADR-0006).

describe("mutation state machine (ADR-0005)", () => {
  it("allows the journal lifecycle transitions", () => {
    expect(isValidMutationTransition("pending", "sending")).toBe(true);
    expect(isValidMutationTransition("sending", "acked")).toBe(true);
    expect(isValidMutationTransition("sending", "failed")).toBe(true);
    expect(isValidMutationTransition("sending", "pending")).toBe(true); // recoverSending
    expect(isValidMutationTransition("failed", "pending")).toBe(true); // retryFailed
  });

  it("rejects illegal transitions", () => {
    expect(isValidMutationTransition("pending", "acked")).toBe(false);
    expect(isValidMutationTransition("acked", "pending")).toBe(false);
    expect(isValidMutationTransition("failed", "acked")).toBe(false);
    expect(() => assertValidMutationTransition("acked", "sending")).toThrow(/Illegal mutation-journal transition/);
  });

  it("treats acked as terminal at the journal level (cleared by reconcile, not a transition)", () => {
    expect(MUTATION_TRANSITIONS.acked).toEqual([]);
  });
});

describe("quarantine state (ADR-0006)", () => {
  it("allows entering quarantine from sending and failed", () => {
    expect(isValidMutationTransition("sending", "quarantined")).toBe(true); // structural 4xx
    expect(isValidMutationTransition("failed", "quarantined")).toBe(true); // hit the attempt cap
  });

  it("treats quarantined as terminal (surfaced, never retried)", () => {
    expect(MUTATION_TRANSITIONS.quarantined).toEqual([]);
    expect(isValidMutationTransition("quarantined", "pending")).toBe(false);
    expect(isValidMutationTransition("quarantined", "sending")).toBe(false);
  });
});

describe("classifyFailureStatus (ADR-0006 decision 4)", () => {
  it("treats transport (no status) and 5xx as transient failures", () => {
    expect(classifyFailureStatus(null)).toBe("failed");
    expect(classifyFailureStatus(undefined)).toBe("failed");
    expect(classifyFailureStatus(500)).toBe("failed");
    expect(classifyFailureStatus(503)).toBe("failed");
  });

  it("treats auth, timeout, and rate-limit 4xx as transient", () => {
    for (const status of [401, 403, 408, 425, 429]) {
      expect(classifyFailureStatus(status)).toBe("failed");
    }
  });

  it("quarantines structural 4xx rejections the server will never accept", () => {
    for (const status of [400, 404, 409, 422]) {
      expect(classifyFailureStatus(status)).toBe("quarantined");
    }
  });

  it("exposes a bounded default attempt cap", () => {
    expect(DEFAULT_MAX_MUTATION_ATTEMPTS).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_MAX_MUTATION_ATTEMPTS)).toBe(true);
  });
});
