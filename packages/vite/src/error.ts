export type GQLensViteErrorCode =
  | "DEV_SERVER_NOT_READY"
  | "INVALID_ENTRY"
  | "INVALID_SCHEMA"
  | "MISSING_HANDLER";

export class GQLensViteError extends Error {
  readonly code: GQLensViteErrorCode;
  readonly details: unknown;

  constructor(options: {
    readonly code: GQLensViteErrorCode;
    readonly message: string;
    readonly details?: unknown;
  }) {
    super(options.message);
    this.name = "GQLensViteError";
    this.code = options.code;
    this.details = options.details;
  }
}
