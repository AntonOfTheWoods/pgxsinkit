export type SyncRuntimePhase = "booting" | "syncing" | "ready" | "degraded";

export interface SyncRuntimeStatus {
  phase: SyncRuntimePhase;
  isRunning: boolean;
  lastError?: string;
}

export interface SyncServerAddress {
  host: string;
  port: number;
}

export interface MutationDiagnostics {
  pendingCount: number;
  sendingCount: number;
  ackedCount: number;
  failedCount: number;
  /** Mutations the server permanently rejected (terminal); surfaced, never retried (ADR-0006). */
  quarantinedCount: number;
  lastFlushAtUs?: string;
  lastAckAtUs?: string;
}
