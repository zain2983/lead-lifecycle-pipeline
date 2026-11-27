/**
 * Errors from the Sim client. Three cases, kept apart on purpose:
 * - `SimApiError`: Sim answered with an error status. `status`, `code` and `detailCode` are exactly what came back.
 * - `SimOutcomeUnknownError`: no answer (timeout, connection reset) or an answer Sim itself marks as ambiguous.
 *   The request may or may not have been applied. Retry an execute with the same `X-Run-Id`; never with a new one.
 * - `SimContractError`: a 2xx whose body doesn't match the pinned v2 contract.
 */

export interface SimApiErrorInit {
  method: string;
  path: string;
  status: number;
  code: string | null;
  message: string;
  detailCode: string | null;
  details: unknown;
  requestId: string | null;
  body: unknown;
}

export class SimApiError extends Error {
  override name = "SimApiError";
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** `error.code` from the v2 envelope, or null when the body wasn't one. */
  readonly code: string | null;
  /** `error.details.code` when present, for example `RUN_ID_CONFLICT`. */
  readonly detailCode: string | null;
  readonly details: unknown;
  readonly requestId: string | null;
  /** The parsed response body (or its text when it wasn't JSON). */
  readonly body: unknown;

  constructor(init: SimApiErrorInit) {
    super(
      `${init.method} ${init.path} -> ${init.status} ${init.code ?? ""}: ${init.message}`.trim(),
    );
    this.method = init.method;
    this.path = init.path;
    this.status = init.status;
    this.code = init.code;
    this.detailCode = init.detailCode;
    this.details = init.details;
    this.requestId = init.requestId;
    this.body = init.body;
  }

  /** The `X-Run-Id` was already claimed. The earlier run exists; this call started nothing. */
  get isRunIdConflict(): boolean {
    return this.status === 409 && this.detailCode === "RUN_ID_CONFLICT";
  }
}

export interface SimOutcomeUnknownErrorInit {
  method: string;
  path: string;
  reason: "timeout" | "network" | "ambiguous_enqueue";
  /** The run ID the caller supplied, so the caller can reconcile. */
  runId?: string;
  cause?: unknown;
}

export class SimOutcomeUnknownError extends Error {
  override name = "SimOutcomeUnknownError";
  readonly outcome = "unknown" as const;
  readonly method: string;
  readonly path: string;
  readonly reason: SimOutcomeUnknownErrorInit["reason"];
  readonly runId: string | undefined;

  constructor(init: SimOutcomeUnknownErrorInit) {
    super(
      `${init.method} ${init.path}: outcome unknown (${init.reason})${init.runId ? ` for run ${init.runId}` : ""}`,
      { cause: init.cause },
    );
    this.method = init.method;
    this.path = init.path;
    this.reason = init.reason;
    this.runId = init.runId;
  }
}

export class SimContractError extends Error {
  override name = "SimContractError";
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body: unknown;

  constructor(method: string, path: string, status: number, body: unknown, issues: string) {
    super(`${method} ${path} -> ${status}: response does not match the v2 contract: ${issues}`);
    this.method = method;
    this.path = path;
    this.status = status;
    this.body = body;
  }
}
