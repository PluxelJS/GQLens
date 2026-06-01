import { canonicalJSON, stepKey } from "./keys";
import type {
  GraphQLOperation,
  PlannedSelectionPath,
  PlannerFieldMetadata,
  PlannerMetadata,
  SelectionPath,
  SelectionStep,
} from "./types";

interface FieldNode {
  readonly step: SelectionStep;
  readonly children: Map<string, FieldNode>;
}

export function plan(
  paths: readonly SelectionPath[],
  operationType = "query",
  metadata?: PlannerMetadata,
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
  const fields = renderNodes([...tree.values()], variables, metadata, undefined, 1);
  const selections = collectPlannedPaths(paths, tree);
  const declarations = variables
    .entries()
    .map(([name, value]) => `$${name}: ${variableType(value, metadata)}`)
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
  variables: VariableRegistry,
  metadata: PlannerMetadata | undefined,
  parentType: string | undefined,
  indent: number,
): string[] {
  const aliases = aliasMap(nodes);
  return nodes
    .slice()
    .toSorted((a, b) => stepKey(a.step).localeCompare(stepKey(b.step)))
    .map((node) =>
      renderNode(node, aliases.get(node) ?? "", variables, metadata, parentType, indent),
    );
}

function renderNode(
  node: FieldNode,
  alias: string,
  variables: VariableRegistry,
  metadata: PlannerMetadata | undefined,
  parentType: string | undefined,
  indent: number,
): string {
  const pad = "  ".repeat(indent);
  const prefix = alias ? `${alias}: ` : "";
  const fieldMeta = parentType
    ? metadata?.types?.[parentType]?.[node.step.field]
    : metadata?.roots?.[node.step.field];
  const args = renderArgs(node.step.args, variables, fieldMeta);
  const childType = fieldMeta?.graphQLType;

  if (node.children.size === 0) {
    return `${pad}${prefix}${node.step.field}${args}`;
  }

  const children = [...node.children.values()].filter((child) => child.step.field !== "ids");
  const childLines = renderNodes(children, variables, metadata, childType, indent + 1);
  if (fieldMeta?.returnsEntity !== false) {
    childLines.push(`${"  ".repeat(indent + 1)}id`);
    childLines.push(`${"  ".repeat(indent + 1)}__typename`);
  }

  const uniqueChildren = [...new Set(childLines)].toSorted();
  return `${pad}${prefix}${node.step.field}${args} {\n${uniqueChildren.join("\n")}\n${pad}}`;
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
  fieldMeta: PlannerFieldMetadata | undefined,
): string {
  if (!args || Object.keys(args).length === 0) {
    return "";
  }
  const rendered = Object.entries(args)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}: $${variables.name(value, fieldMeta?.args?.[key])}`);
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

function variableType(entry: VariableEntry, metadata: PlannerMetadata | undefined): string {
  void metadata;
  if (entry.type) {
    return entry.type;
  }
  const value = entry.value;
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
      if (step.field === "ids") {
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
