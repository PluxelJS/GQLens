import { relationSlotKey, slotKey, stepKey } from "../keys";
import type { EntityRef, SelectionStep } from "../types";

export type CacheSlotSuffix = "ids" | "refs";

export function rootSlotKey(
  root: string,
  steps: readonly SelectionStep[],
  suffix?: CacheSlotSuffix,
): string {
  return slotKey(root, steps, suffix);
}

export function entityFieldKey(ref: EntityRef, key: string): string {
  return `${ref.type}:${ref.id}.${key}`;
}

export function entityRelationKey(
  ref: EntityRef,
  step: SelectionStep,
  suffix?: CacheSlotSuffix,
): string {
  return relationSlotKey(ref, step, suffix);
}

export function cacheFieldKey(steps: readonly SelectionStep[]): string {
  return steps
    .filter((step) => !step.typeCondition)
    .map(stepKey)
    .join(".");
}

export function fieldStepForPath(steps: readonly SelectionStep[]): SelectionStep | undefined {
  const last = steps[steps.length - 1];
  if (!last) {
    return undefined;
  }
  return steps.length === 1 ? last : { field: cacheFieldKey(steps) };
}

export function ownerFieldSteps(
  steps: readonly SelectionStep[],
  ownerFieldStartIndex: number,
): readonly SelectionStep[] {
  return steps.slice(ownerFieldStartIndex);
}

export function suffixedSlotKey(key: string, suffix: CacheSlotSuffix): string {
  return `${key}.${suffix}`;
}

export function isListIdentityStep(step: SelectionStep | undefined): boolean {
  return step?.field === "ids" || step?.field === "refs";
}
