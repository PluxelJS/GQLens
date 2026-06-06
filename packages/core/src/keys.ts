import type { EntityRef, SelectionPath, SelectionStep, VariablePlaceholder } from "./types";

export function selectionKey(path: SelectionPath): string {
  return `${path.root}.${stepsKey(path.steps)}`;
}

export function slotKey(root: string, steps: readonly SelectionStep[], suffix?: string): string {
  const key = `${root}.${stepsKey(steps)}`;
  return suffix ? `${key}.${suffix}` : key;
}

export function relationSlotKey(ref: EntityRef, step: SelectionStep, suffix?: string): string {
  const key = `${ref.type}:${ref.id}.${stepKey(step)}`;
  return suffix ? `${key}.${suffix}` : key;
}

export function stepKey(step: SelectionStep): string {
  if (step.typeCondition) {
    return `$on(${step.typeCondition})`;
  }
  if (!step.args || Object.keys(step.args).length === 0) {
    return step.field;
  }
  return `${step.field}(${canonicalJSON(step.args)})`;
}

export function canonicalJSON(value: unknown): string {
  if (isVariablePlaceholder(value)) {
    return `$${value["__gqlensVariable"]}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJSON(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stepsKey(steps: readonly SelectionStep[]): string {
  return steps.map(stepKey).join(".");
}

export function isVariablePlaceholder(value: unknown): value is VariablePlaceholder {
  return (
    typeof value === "object" &&
    value !== null &&
    "__gqlensVariable" in value &&
    typeof value["__gqlensVariable"] === "string"
  );
}
