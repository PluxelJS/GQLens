import { canonicalJSON, isVariablePlaceholder, stepKey } from "./keys";
import type {
  GQLensFieldContract,
  GQLensSchemaContract,
  GraphQLOperation,
  PlannedSelectionPath,
  SelectionPath,
  SelectionStep,
} from "./types";
import {
  fieldPossibleTypes,
  fieldReturnsEntity,
  fieldTypeName,
  objectFieldContract,
  rootFieldContract,
} from "./schema";

interface FieldNode {
  readonly step: SelectionStep;
  readonly children: Map<string, FieldNode>;
}

interface RenderContext {
  readonly variables: VariableRegistry;
  readonly schema: GQLensSchemaContract | undefined;
  readonly operationType: string;
}

interface RenderScope {
  readonly parentType?: string | undefined;
  readonly indent: number;
}

export function plan(
  paths: readonly SelectionPath[],
  operationType = "query",
  schema?: GQLensSchemaContract,
): GraphQLOperation {
  if (paths.length === 0) {
    return {
      query: `${operationType} GQLens { __typename }`,
      variables: {},
      operationName: "GQLens",
      selections: [],
    };
  }

  const variables = createVariableRegistry();
  const tree = buildTree(paths);
  const fields = renderNodes(
    [...tree.values()],
    { variables, schema, operationType },
    { indent: 1 },
  );
  const selections = collectPlannedPaths(paths, tree);
  const declarations = variables
    .entries()
    .map(([name, value]) => `$${name}: ${variableType(value)}`)
    .join(", ");
  const header = declarations
    ? `${operationType} GQLens(${declarations})`
    : `${operationType} GQLens`;

  return {
    query: `${header} {\n${fields.join("\n")}\n}`,
    variables: variables.values,
    operationName: "GQLens",
    selections,
  };
}

function buildTree(paths: readonly SelectionPath[]): Map<string, FieldNode> {
  const root = new Map<string, FieldNode>();
  for (const path of paths) {
    let current = root;
    for (const step of path.steps) {
      const key = stepKey(step);
      const existing = current.get(key);
      if (existing) {
        current = existing.children;
        continue;
      }

      const node: FieldNode = { step, children: new Map() };
      current.set(key, node);
      current = node.children;
    }
  }
  return root;
}

function renderNodes(
  nodes: readonly FieldNode[],
  context: RenderContext,
  scope: RenderScope,
): string[] {
  const aliases = aliasMap(nodes);
  return nodes
    .slice()
    .toSorted((a, b) => stepKey(a.step).localeCompare(stepKey(b.step)))
    .map((node) => renderNode(node, aliases.get(node) ?? "", context, scope));
}

function renderNode(
  node: FieldNode,
  alias: string,
  context: RenderContext,
  scope: RenderScope,
): string {
  const { variables, schema, operationType } = context;
  const { parentType, indent } = scope;
  const pad = "  ".repeat(indent);
  if (node.step.typeCondition) {
    const children = [...node.children.values()];
    const childLines = renderNodes(children, context, childScope(node.step.typeCondition, indent));
    childLines.push(`${"  ".repeat(indent + 1)}id`);
    childLines.push(`${"  ".repeat(indent + 1)}__typename`);
    const uniqueChildren = [...new Set(childLines)].toSorted();
    return `${pad}... on ${node.step.typeCondition} {\n${uniqueChildren.join("\n")}\n${pad}}`;
  }

  const prefix = alias ? `${alias}: ` : "";
  const field = parentType
    ? objectFieldContract(schema, parentType, node.step.field)
    : rootFieldContract(schema, operationType, node.step.field);
  const args = renderArgs(node.step.args, variables, field);
  const childType = fieldTypeName(field);

  if (node.children.size === 0) {
    return `${pad}${prefix}${node.step.field}${args}`;
  }

  const identityField = [...node.children.values()].find((child) => isListIdentityStep(child.step));
  const children = [...node.children.values()].filter((child) => !isListIdentityStep(child.step));
  const childLines = renderNodes(children, context, childScope(childType, indent));
  if (
    field?.result.kind === "object" &&
    field.result.isAbstract &&
    identityField?.step.field === "refs"
  ) {
    childLines.push(`${"  ".repeat(indent + 1)}__typename`);
    for (const type of fieldPossibleTypes(field) ?? []) {
      childLines.push(
        `${"  ".repeat(indent + 1)}... on ${type} {\n${"  ".repeat(indent + 2)}id\n${"  ".repeat(indent + 1)}}`,
      );
    }
  } else if (!schema || !field || fieldReturnsEntity(field)) {
    childLines.push(`${"  ".repeat(indent + 1)}id`);
    childLines.push(`${"  ".repeat(indent + 1)}__typename`);
  }

  const uniqueChildren = [...new Set(childLines)].toSorted();
  return `${pad}${prefix}${node.step.field}${args} {\n${uniqueChildren.join("\n")}\n${pad}}`;
}

function childScope(parentType: string | undefined, parentIndent: number): RenderScope {
  return { parentType, indent: parentIndent + 1 };
}

function aliasMap(nodes: readonly FieldNode[]): Map<FieldNode, string> {
  const byField = new Map<string, FieldNode[]>();
  for (const node of nodes) {
    const group = byField.get(node.step.field) ?? [];
    group.push(node);
    byField.set(node.step.field, group);
  }

  const aliases = new Map<FieldNode, string>();
  for (const [field, group] of byField) {
    if (group.length < 2) {
      continue;
    }
    group
      .slice()
      .toSorted((a, b) => stepKey(a.step).localeCompare(stepKey(b.step)))
      .forEach((node, index) => {
        aliases.set(node, `${field}_${index}`);
      });
  }
  return aliases;
}

function renderArgs(
  args: Record<string, unknown> | undefined,
  variables: VariableRegistry,
  field: GQLensFieldContract | undefined,
): string {
  if (!args || Object.keys(args).length === 0) {
    return "";
  }
  const rendered = Object.entries(args)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}: $${variables.name(value, field?.args?.[key])}`);
  return `(${rendered.join(", ")})`;
}

interface VariableEntry {
  readonly name: string;
  readonly value: unknown;
  readonly type: string | undefined;
}

interface VariableRegistry {
  readonly values: Record<string, unknown>;
  name(value: unknown, type: string | undefined): string;
  entries(): [string, VariableEntry][];
}

function createVariableRegistry(): VariableRegistry {
  const values: Record<string, unknown> = {};
  const entries = new Map<string, VariableEntry>();

  return {
    values,

    name(value: unknown, type: string | undefined): string {
      if (isVariablePlaceholder(value)) {
        const name = value["__gqlensVariable"];
        const key = `${type ?? ""}:$${name}`;
        const existing = entries.get(key);
        if (existing) {
          return existing.name;
        }
        entries.set(key, { name, value, type });
        return name;
      }

      const key = `${type ?? ""}:${canonicalJSON(value)}`;
      const existing = entries.get(key);
      if (existing) {
        return existing.name;
      }

      const name = `v${entries.size}`;
      values[name] = value;
      entries.set(key, { name, value, type });
      return name;
    },

    entries(): [string, VariableEntry][] {
      return [...entries.values()].map((entry) => [entry.name, entry]);
    },
  };
}

function variableType(entry: VariableEntry): string {
  if (entry.type) {
    return entry.type;
  }
  const value = entry.value;
  if (isVariablePlaceholder(value)) {
    return "String";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "Int" : "Float";
  }
  if (typeof value === "boolean") {
    return "Boolean";
  }
  return "String";
}

function collectPlannedPaths(
  paths: readonly SelectionPath[],
  tree: ReadonlyMap<string, FieldNode>,
): PlannedSelectionPath[] {
  return paths.map((path) => {
    let siblings = tree;
    const steps = path.steps.map((step) => {
      if (isListIdentityStep(step)) {
        return { ...step, responseKey: undefined };
      }

      if (step.typeCondition) {
        const node = siblings.get(stepKey(step));
        if (node) {
          siblings = node.children;
        }
        return { ...step, responseKey: undefined };
      }

      const node = siblings.get(stepKey(step));
      const alias = node ? aliasMap([...siblings.values()]).get(node) : undefined;
      if (node) {
        siblings = node.children;
      }
      return { ...step, responseKey: alias || step.field };
    });

    return { root: path.root, steps };
  });
}

function isListIdentityStep(step: SelectionStep): boolean {
  return step.field === "ids" || step.field === "refs";
}
