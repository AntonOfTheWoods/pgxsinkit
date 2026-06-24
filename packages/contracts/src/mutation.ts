import { z } from "zod";

import { unixMicrosecondsSchema } from "./common";

export const mutationKindSchema = z.enum(["create", "update", "delete"]);
/**
 * The full Mutation-journal status machine — every status a journal row can hold, including the two
 * terminal states (`quarantined`, ADR-0006; `conflicted`, ADR-0015). Kept in lockstep with the
 * client's `MutationStatus` (packages/client/src/mutation-state.ts). Distinct from
 * {@link mutationAckStatusSchema}, the narrower *transport* subset a server ack may carry.
 */
export const mutationStatusSchema = z.enum(["pending", "sending", "acked", "failed", "quarantined", "conflicted"]);
export const mutationAckStatusSchema = z.enum(["acked", "failed", "conflicted"]);

export const entityKeySchema = z.record(z.string().trim().min(1), z.string().trim().min(1));

export const mutationEnvelopeSchema = z
  .object({
    tableName: z.string().trim().min(1),
    entityKey: entityKeySchema,
    mutationId: z.uuid(),
    mutationSeq: z.number().int().nonnegative(),
    kind: mutationKindSchema,
    payload: z.unknown(),
    clientTimestampUs: unixMicrosecondsSchema,
    /**
     * The Base server version this write was authored against (ADR-0015): the row's Server version
     * at enqueue for a chain head, or its predecessor's resolved version for a chained write. The
     * applier compares the row's *current* Server version to it — `current > base` ⇒ a stale write
     * (an external write interleaved). Absent on a `create` (its conflict is a PK collision, a
     * separate concern) and on any write whose table predates the policy; absence means no stale
     * check runs.
     */
    baseServerVersion: unixMicrosecondsSchema.optional(),
  })
  .strict();

export const mutationAckSchema = z
  .object({
    tableName: z.string().trim().min(1),
    entityKey: entityKeySchema,
    mutationId: z.uuid(),
    mutationSeq: z.number().int().nonnegative(),
    status: mutationAckStatusSchema,
    serverUpdatedAtUs: unixMicrosecondsSchema.optional(),
    conflictReason: z.string().trim().min(1).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  })
  .strict();

export const batchMutationRequestSchema = z
  .object({
    mutations: z.array(mutationEnvelopeSchema).min(1),
  })
  .strict();

export const batchMutationAckSchema = z
  .object({
    acks: z.array(mutationAckSchema),
  })
  .strict();

/**
 * Per-mutation attribution for a structural batch rejection. The batch write is atomic —
 * one structurally-invalid mutation rejects the whole POST with a single non-2xx — so the
 * server names the offending mutation(s) here. That lets the client quarantine exactly those
 * and keep the innocent siblings retryable, instead of dragging the whole offline queue to
 * quarantine at the shared attempt cap.
 */
export const mutationRejectionSchema = z
  .object({
    tableName: z.string().trim().min(1),
    mutationId: z.uuid(),
    mutationSeq: z.number().int().nonnegative(),
    reason: z.string().trim().min(1),
  })
  .strict();

/**
 * The body of a non-2xx batch-mutation response. `rejections` is present only when the fault
 * is attributable to specific mutations (payload validation); whole-batch faults (execution
 * 5xx, auth, malformed envelope) carry just a `message`. Unknown extra fields are stripped.
 */
export const batchMutationErrorSchema = z.object({
  message: z.string().optional(),
  rejections: z.array(mutationRejectionSchema).optional(),
});

export type MutationKind = z.infer<typeof mutationKindSchema>;
export type MutationStatus = z.infer<typeof mutationStatusSchema>;
export type MutationAckStatus = z.infer<typeof mutationAckStatusSchema>;
export type EntityKey = z.infer<typeof entityKeySchema>;
export type MutationEnvelope = z.infer<typeof mutationEnvelopeSchema>;
export type MutationAck = z.infer<typeof mutationAckSchema>;
export type BatchMutationRequest = z.infer<typeof batchMutationRequestSchema>;
export type BatchMutationAck = z.infer<typeof batchMutationAckSchema>;
export type MutationRejection = z.infer<typeof mutationRejectionSchema>;
export type BatchMutationError = z.infer<typeof batchMutationErrorSchema>;
