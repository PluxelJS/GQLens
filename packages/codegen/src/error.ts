export type GQLensCodegenErrorCode = "INVALID_SCHEMA_CONTRACT" | "INVALID_SCHEMA_INPUT";

export class GQLensCodegenError extends Error {
  readonly code: GQLensCodegenErrorCode;
  readonly details: unknown;

  constructor(options: {
    readonly code: GQLensCodegenErrorCode;
    readonly message: string;
    readonly details?: unknown;
  }) {
    super(options.message);
    this.name = "GQLensCodegenError";
    this.code = options.code;
    this.details = options.details;
  }
}
