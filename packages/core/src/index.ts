export interface Lens {
  readonly query: string;
  readonly shape: Record<string, unknown>;
}

export interface LensOptions {
  readonly query: string;
}

export function createLens(options: LensOptions): Lens {
  return {
    query: options.query,
    shape: {},
  };
}
