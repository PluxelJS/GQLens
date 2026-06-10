export type GQLensErrorCode =
  | "GRAPHQL_REQUEST_FAILED"
  | "GRAPHQL_RESPONSE_ERRORS"
  | "LIVE_QUERY_ERROR"
  | "PREPARED_VARIABLE_MISSING"
  | "PROVIDER_MISSING"
  | "WEBSOCKET_UNAVAILABLE";

export class GQLensError extends Error {
  readonly code: GQLensErrorCode;
  readonly details: unknown;

  constructor(options: {
    readonly code: GQLensErrorCode;
    readonly message: string;
    readonly details?: unknown;
  }) {
    super(options.message);
    this.name = "GQLensError";
    this.code = options.code;
    this.details = options.details;
  }
}
