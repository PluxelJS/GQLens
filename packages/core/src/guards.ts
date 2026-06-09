export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isEntityObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && "__typename" in value && "id" in value;
}
