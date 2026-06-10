import type {
  GraphDataAddress,
  EntityRef,
  GraphDataStore,
  PlannerMetadata,
  SelectionPath,
  SelectionStep,
} from "../types";
import { fieldStepForPath, isListIdentityStep } from "./address";
import { isExpiresFresh } from "./store";

interface OwnerResolution {
  readonly value: EntityRef | null | undefined;
  readonly fresh: boolean;
  readonly fieldStartIndex: number;
}

interface SlotSnapshot<T> {
  readonly value: T | undefined;
  readonly fresh: boolean;
}

export function isSelectionFresh(
  store: GraphDataStore,
  path: SelectionPath,
  metadata: PlannerMetadata | undefined,
): boolean {
  if (path.steps.length === 0) {
    return false;
  }
  const last = path.steps[path.steps.length - 1];
  if (!last) {
    return false;
  }

  if (isListIdentityStep(last)) {
    return isListPathFresh(store, path, metadata);
  }

  const owner = resolveOwner(store, path, metadata);
  if (owner.value === null) {
    return owner.fresh;
  }
  if (owner.value) {
    return (
      owner.fresh &&
      store.isFresh({
        owner: { kind: "entity", ref: owner.value },
        path: path.steps.slice(owner.fieldStartIndex),
      })
    );
  }

  return store.isFresh({ owner: { kind: "root", root: path.root }, path: path.steps });
}

function isListPathFresh(
  store: GraphDataStore,
  path: SelectionPath,
  metadata: PlannerMetadata | undefined,
): boolean {
  const relationStep = path.steps[path.steps.length - 2];
  const identityStep = path.steps[path.steps.length - 1];
  if (!relationStep) {
    return false;
  }

  const relationSteps = path.steps.slice(0, -1);
  if (relationSteps.length === 1) {
    return isListAddressFresh(
      store,
      { owner: { kind: "root", root: path.root }, path: relationSteps },
      identityStep?.field,
    );
  }

  const owner = resolveOwnerForSteps(store, path.root, relationSteps.slice(0, -1), metadata);
  if (owner.value === null) {
    return owner.fresh;
  }
  if (!owner.value) {
    return isListAddressFresh(
      store,
      { owner: { kind: "root", root: path.root }, path: relationSteps },
      identityStep?.field,
    );
  }
  const ownerRelationSteps = relationSteps.slice(owner.fieldStartIndex);
  const ownerRelationStep = fieldStepForPath(ownerRelationSteps) ?? relationStep;
  return owner.fresh
    ? isListAddressFresh(
        store,
        { owner: { kind: "entity", ref: owner.value }, path: [ownerRelationStep] },
        identityStep?.field,
      )
    : false;
}

function resolveOwner(
  store: GraphDataStore,
  path: SelectionPath,
  metadata: PlannerMetadata | undefined,
): OwnerResolution {
  return resolveOwnerForSteps(store, path.root, path.steps.slice(0, -1), metadata);
}

function resolveOwnerForSteps(
  store: GraphDataStore,
  root: string,
  steps: readonly SelectionStep[],
  metadata: PlannerMetadata | undefined,
): OwnerResolution {
  let ref: EntityRef | undefined;
  let fresh = true;
  let fieldStartIndex = 0;
  const walked: SelectionStep[] = [];

  for (const [index, step] of steps.entries()) {
    walked.push(step);

    if (step.typeCondition) {
      if (!ref || !matchesRefTypeCondition(ref, step.typeCondition, metadata)) {
        return { value: null, fresh, fieldStartIndex: index + 1 };
      }
      continue;
    }

    if (!ref) {
      const rootSlot = readAddress<EntityRef | null>(store, {
        owner: { kind: "root", root },
        path: walked,
      });
      if (rootSlot.value !== undefined) {
        if (!rootSlot.value) {
          return { value: null, fresh: rootSlot.fresh, fieldStartIndex: index + 1 };
        }
        ref = rootSlot.value;
        fresh &&= rootSlot.fresh;
        fieldStartIndex = index + 1;
        continue;
      }

      const typeName = metadata?.roots?.[step.field]?.graphQLType;
      const id = step.args?.["id"];
      if (typeName && id !== undefined) {
        ref = store.entity(typeName, String(id));
        fieldStartIndex = index + 1;
        continue;
      }

      return { value: undefined, fresh: false, fieldStartIndex };
    }

    const relationStep =
      index > fieldStartIndex ? fieldStepForPath(steps.slice(fieldStartIndex, index + 1)) : step;
    if (!relationStep) {
      return { value: undefined, fresh: false, fieldStartIndex };
    }
    const relationSlot = readAddress<EntityRef | null>(store, {
      owner: { kind: "entity", ref },
      path: [relationStep],
      facet: "link",
    });
    if (relationSlot.value === undefined) {
      continue;
    }
    if (!relationSlot.value) {
      return { value: null, fresh: fresh && relationSlot.fresh, fieldStartIndex: index + 1 };
    }
    ref = relationSlot.value;
    fresh &&= relationSlot.fresh;
    fieldStartIndex = index + 1;
  }

  return ref
    ? { value: ref, fresh, fieldStartIndex }
    : { value: undefined, fresh: false, fieldStartIndex };
}

function isListAddressFresh(
  store: GraphDataStore,
  address: GraphDataAddress,
  identityField: string | undefined,
): boolean {
  if (identityField === "refs") {
    const refs = readAddress<readonly EntityRef[]>(store, { ...address, facet: "refs" });
    return refs.fresh;
  }

  if (identityField === "ids") {
    const ids = readAddress<readonly string[]>(store, { ...address, facet: "ids" });
    return ids.fresh;
  }

  const relation = readAddress<readonly EntityRef[] | null>(store, {
    ...address,
    facet: address.owner.kind === "entity" ? "link" : address.facet,
  });
  return relation.value === null ? relation.fresh : false;
}

function readAddress<T>(store: GraphDataStore, address: GraphDataAddress): SlotSnapshot<T> {
  const entry = store.peek<T | undefined>(address);
  if (!entry) {
    return { value: undefined, fresh: false };
  }
  const value = entry.sig();
  return {
    value,
    fresh: value !== undefined && isFreshEntry(entry),
  };
}

function isFreshEntry(entry: { readonly expires: number }): boolean {
  return isExpiresFresh(entry.expires);
}

function matchesRefTypeCondition(
  ref: EntityRef,
  typeCondition: string,
  metadata: PlannerMetadata | undefined,
): boolean {
  return (
    ref.type === typeCondition ||
    (metadata?.types?.[typeCondition]?.["__typename"]?.possibleTypes?.includes(ref.type) ?? false)
  );
}
