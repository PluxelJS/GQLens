type AstNode = {
  readonly type: string;
  readonly parent?: AstNode | undefined;
  readonly [key: string]: unknown;
};

type RuleContext = {
  report(diagnostic: { readonly node: AstNode; readonly message: string }): void;
};

type Visitor = Record<string, (node: AstNode) => void>;

type Rule = {
  readonly meta: {
    readonly type: "problem";
    readonly docs: {
      readonly description: string;
      readonly recommended: true;
    };
    readonly messages: Readonly<Record<string, string>>;
    readonly schema: readonly [];
  };
  create(context: RuleContext): Visitor;
};

type Plugin = {
  readonly meta: {
    readonly name: "gqlens";
  };
  readonly rules: Readonly<Record<string, Rule>>;
};

type State = {
  readonly runtimeVars: Set<string>;
  readonly accessorVars: Set<string>;
};

type SelectorContext = {
  readonly kind: "defineSelection" | "defineInvalidation";
  readonly qName: string | undefined;
  readonly vName: string | undefined;
};

type FunctionFrame = {
  hasRuntimeQuery: boolean;
  readonly nestedUnderRuntimeQuery: boolean;
  readonly selector: SelectorContext | null;
};

const runtimeEntryNames = new Set([
  "useQuery",
  "useLiveQuery",
  "usePreparedQuery",
  "createQuery",
  "createLiveQuery",
  "createPreparedQuery",
]);
const selectorEntryNames = new Set(["defineSelection", "defineInvalidation"]);
const objectOperationNames = new Set([
  "assign",
  "entries",
  "fromEntries",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "keys",
  "values",
]);

const noAccessorEscape = createRule(
  "no-accessor-escape",
  "Accessor nodes must not escape their reader scope.",
  (context) => {
    const state = createState();

    return {
      Program() {
        resetState(state);
      },

      VariableDeclarator(node) {
        trackRuntimeBinding(state, node);
        const id = nodeProp(node, "id");
        if (isIdentifier(id) && isDefiniteAccessorNode(nodeProp(node, "init"), state)) {
          state.accessorVars.add(identifierName(id));
        }
      },

      Identifier(node) {
        if (!isIdentifier(node)) {
          return;
        }
        if (!state.accessorVars.has(identifierName(node)) || isBindingIdentifier(node)) {
          return;
        }
        if (isSafeAccessorUse(node)) {
          return;
        }
        report(context, node, "Do not let a GQLens accessor escape its reader scope.");
      },

      JSXExpressionContainer(node) {
        if (isDefiniteAccessorNode(nodeProp(node, "expression"), state)) {
          report(context, node, "Pass entity identity instead of a GQLens accessor.");
        }
      },

      ReturnStatement(node) {
        if (isDefiniteAccessorNode(nodeProp(node, "argument"), state)) {
          report(context, node, "Return data or identity, not a GQLens accessor.");
        }
      },
    };
  },
);

const noUntrackedRead = createRule(
  "no-untracked-read",
  "Field reads must happen in a tracked GQLens context.",
  (context) => {
    const state = createState();
    const stack: FunctionFrame[] = [];

    function current(): FunctionFrame | undefined {
      return stack.at(-1);
    }

    function enterFunction(node: AstNode): void {
      stack.push({
        hasRuntimeQuery: false,
        nestedUnderRuntimeQuery: stack.some((item) => item.hasRuntimeQuery),
        selector: selectorContextForFunction(node),
      });
    }

    function leaveFunction(): void {
      stack.pop();
    }

    return {
      Program() {
        resetState(state);
        stack.length = 0;
      },

      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": leaveFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": leaveFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": leaveFunction,

      VariableDeclarator(node) {
        trackRuntimeBinding(state, node);
        const frame = current();
        const id = nodeProp(node, "id");
        if (frame && isIdentifier(id) && isRuntimeEntryCall(nodeProp(node, "init"))) {
          frame.hasRuntimeQuery = true;
        }
      },

      MemberExpression(node) {
        const frame = current();
        if (!frame || frame.selector || !frame.nestedUnderRuntimeQuery) {
          return;
        }
        if (!isChainRootedInRuntimeQuery(node, state)) {
          return;
        }
        if (memberDepthFromRoot(node) < 2) {
          return;
        }
        report(context, node, "Read GQLens fields in render or an explicit selector context.");
      },
    };
  },
);

const noAccessorObjectOps = createRule(
  "no-accessor-object-ops",
  "Accessor nodes are not data objects.",
  (context) => {
    const state = createState();

    return {
      Program() {
        resetState(state);
      },

      VariableDeclarator(node) {
        trackRuntimeBinding(state, node);
        const id = nodeProp(node, "id");
        if (isIdentifier(id) && isDefiniteAccessorNode(nodeProp(node, "init"), state)) {
          state.accessorVars.add(identifierName(id));
        }
      },

      SpreadElement(node) {
        if (isAccessorLike(nodeProp(node, "argument"), state)) {
          report(context, node, "Do not spread a GQLens accessor.");
        }
      },

      ForInStatement(node) {
        if (isAccessorLike(nodeProp(node, "right"), state)) {
          report(context, node, "Do not enumerate a GQLens accessor.");
        }
      },

      BinaryExpression(node) {
        if (
          stringProp(node, "operator") === "in" &&
          isAccessorLike(nodeProp(node, "right"), state)
        ) {
          report(context, node, "Do not use `in` against a GQLens accessor.");
        }
      },

      CallExpression(node) {
        if (
          isObjectOperation(node) &&
          nodeArray(node, "arguments").some((arg) => isAccessorLike(arg, state))
        ) {
          report(context, node, "Do not use object operations on a GQLens accessor.");
        }
      },
    };
  },
);

const selectorPure = createRule(
  "selector-pure",
  "GQLens selector callbacks must be pure path collectors.",
  (context) => {
    const selectorStack: Array<SelectorContext | null> = [];

    function currentSelector(): SelectorContext | null | undefined {
      return selectorStack.at(-1);
    }

    function enterFunction(node: AstNode): void {
      const selector = selectorContextForFunction(node);
      if (currentSelector() && !selector) {
        report(context, node, "Do not create nested functions inside GQLens selectors.");
      }
      selectorStack.push(selector);
    }

    function leaveFunction(): void {
      selectorStack.pop();
    }

    function reportImpure(
      node: AstNode,
      message = "Keep GQLens selectors as pure path collectors.",
    ): void {
      if (currentSelector()) {
        report(context, node, message);
      }
    }

    return {
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": leaveFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": leaveFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": leaveFunction,

      IfStatement: reportImpure,
      ForStatement: reportImpure,
      ForInStatement: reportImpure,
      ForOfStatement: reportImpure,
      WhileStatement: reportImpure,
      DoWhileStatement: reportImpure,
      SwitchStatement: reportImpure,
      AwaitExpression: reportImpure,
      AssignmentExpression: reportImpure,
      UpdateExpression: reportImpure,
      YieldExpression: reportImpure,
      ThrowStatement: reportImpure,
      TryStatement: reportImpure,

      CallExpression(node) {
        const selector = currentSelector();
        if (!selector || isAllowedSelectorCall(node, selector)) {
          return;
        }
        report(context, node, "Only accessor calls and variable placeholders are allowed here.");
      },
    };
  },
);

const plainArgs = createRule(
  "plain-args",
  "GQLens args must be canonical GraphQL input values.",
  (context) => {
    const state = createState();

    return {
      Program() {
        resetState(state);
      },

      VariableDeclarator(node) {
        trackRuntimeBinding(state, node);
      },

      CallExpression(node) {
        if (!isAccessorCall(node, state)) {
          return;
        }
        for (const arg of nodeArray(node, "arguments")) {
          if (containsObviouslyNonPlainArg(arg)) {
            report(context, arg, "Use plain GraphQL input values for GQLens args.");
          }
        }
      },
    };
  },
);

const plugin: Plugin = {
  meta: {
    name: "gqlens",
  },
  rules: {
    "no-accessor-escape": noAccessorEscape,
    "no-untracked-read": noUntrackedRead,
    "no-accessor-object-ops": noAccessorObjectOps,
    "selector-pure": selectorPure,
    "plain-args": plainArgs,
  },
};

export default plugin;

function createRule(
  name: string,
  description: string,
  create: (context: RuleContext) => Visitor,
): Rule {
  return {
    meta: {
      type: "problem",
      docs: {
        description,
        recommended: true,
      },
      messages: {
        [name]: description,
      },
      schema: [],
    },
    create,
  };
}

function createState(): State {
  return {
    runtimeVars: new Set(),
    accessorVars: new Set(),
  };
}

function resetState(state: State): void {
  state.runtimeVars.clear();
  state.accessorVars.clear();
}

function report(context: RuleContext, node: AstNode, message: string): void {
  context.report({ node, message });
}

function trackRuntimeBinding(state: State, node: AstNode): void {
  const id = nodeProp(node, "id");
  if (isIdentifier(id) && isRuntimeEntryCall(nodeProp(node, "init"))) {
    state.runtimeVars.add(identifierName(id));
  }
}

function isRuntimeEntryCall(node: AstNode | undefined): boolean {
  const callee = nodeProp(node, "callee");
  return (
    node?.type === "CallExpression" &&
    isIdentifier(callee) &&
    runtimeEntryNames.has(identifierName(callee))
  );
}

function selectorContextForFunction(node: AstNode): SelectorContext | null {
  const call = node.parent;
  if (call?.type !== "CallExpression" || nodeArray(call, "arguments")[0] !== node) {
    return null;
  }
  const callee = nodeProp(call, "callee");
  if (!isIdentifier(callee) || !selectorEntryNames.has(identifierName(callee))) {
    return null;
  }
  const [q, v] = nodeArray(node, "params");
  return {
    kind: identifierName(callee) as SelectorContext["kind"],
    qName: isIdentifier(q) ? identifierName(q) : undefined,
    vName: isIdentifier(v) ? identifierName(v) : undefined,
  };
}

function isDefiniteAccessorNode(node: AstNode | undefined, state: State): boolean {
  return (
    node?.type === "CallExpression" &&
    (isChainRootedInRuntimeQuery(node, state) || isChainRootedInAccessorVar(node, state))
  );
}

function isAccessorLike(node: AstNode | undefined, state: State): boolean {
  return (
    isChainRootedInRuntimeQuery(node, state) ||
    isChainRootedInAccessorVar(node, state) ||
    (isIdentifier(node) && state.accessorVars.has(identifierName(node)))
  );
}

function isAccessorCall(node: AstNode, state: State): boolean {
  return node.type === "CallExpression" && isChainRootedInRuntimeQuery(node, state);
}

function isChainRootedInRuntimeQuery(node: AstNode | undefined, state: State): boolean {
  const root = expressionRoot(node);
  return isIdentifier(root) && state.runtimeVars.has(identifierName(root));
}

function isChainRootedInAccessorVar(node: AstNode | undefined, state: State): boolean {
  const root = expressionRoot(node);
  return isIdentifier(root) && state.accessorVars.has(identifierName(root));
}

function expressionRoot(node: AstNode | undefined): AstNode | undefined {
  let current = node;
  while (current) {
    if (current.type === "ChainExpression") {
      current = nodeProp(current, "expression");
      continue;
    }
    if (current.type === "MemberExpression") {
      current = nodeProp(current, "object");
      continue;
    }
    if (current.type === "CallExpression") {
      current = nodeProp(current, "callee");
      continue;
    }
    if (current.type === "TSNonNullExpression" || current.type === "TSAsExpression") {
      current = nodeProp(current, "expression");
      continue;
    }
    return current;
  }
  return undefined;
}

function memberDepthFromRoot(node: AstNode | undefined): number {
  let current = node;
  let depth = 0;
  while (current) {
    if (current.type === "MemberExpression") {
      depth++;
      current = nodeProp(current, "object");
      continue;
    }
    if (current.type === "CallExpression") {
      current = nodeProp(current, "callee");
      continue;
    }
    if (current.type === "ChainExpression") {
      current = nodeProp(current, "expression");
      continue;
    }
    return depth;
  }
  return depth;
}

function isBindingIdentifier(node: AstNode): boolean {
  const parent = node.parent;
  return (
    (parent?.type === "VariableDeclarator" && nodeProp(parent, "id") === node) ||
    (parent?.type === "FunctionDeclaration" && nodeProp(parent, "id") === node) ||
    (parent?.type === "FunctionExpression" && nodeProp(parent, "id") === node) ||
    (parent?.type === "ImportSpecifier" && nodeProp(parent, "local") === node) ||
    (parent?.type === "ImportDefaultSpecifier" && nodeProp(parent, "local") === node)
  );
}

function isSafeAccessorUse(node: AstNode): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (parent.type === "MemberExpression" && nodeProp(parent, "object") === node) {
    return true;
  }
  if (parent.type === "CallExpression" && nodeProp(parent, "callee") === node) {
    return true;
  }
  return parent.type === "VariableDeclarator" && nodeProp(parent, "id") === node;
}

function isObjectOperation(node: AstNode): boolean {
  const callee = nodeProp(node, "callee");
  if (!callee || callee.type !== "MemberExpression") {
    return false;
  }
  const object = nodeProp(callee, "object");
  const property = nodeProp(callee, "property");
  if (isIdentifier(object) && identifierName(object) === "Object") {
    const name = propertyName(property);
    return Boolean(name && objectOperationNames.has(name));
  }
  return isJsonStringify(callee);
}

function isJsonStringify(callee: AstNode): boolean {
  const object = nodeProp(callee, "object");
  return (
    isIdentifier(object) &&
    identifierName(object) === "JSON" &&
    propertyName(nodeProp(callee, "property")) === "stringify"
  );
}

function propertyName(property: AstNode | undefined): string | undefined {
  if (isIdentifier(property)) {
    return identifierName(property);
  }
  if (property?.type === "Literal") {
    const value = property["value"];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function isAllowedSelectorCall(node: AstNode, selector: SelectorContext): boolean {
  const callee = nodeProp(node, "callee");
  if (isIdentifier(callee) && identifierName(callee) === selector.vName) {
    return selector.kind === "defineSelection";
  }
  const root = expressionRoot(node);
  return isIdentifier(root) && identifierName(root) === selector.qName;
}

function containsObviouslyNonPlainArg(node: AstNode): boolean {
  if (
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "NewExpression"
  ) {
    return true;
  }
  if (node.type === "CallExpression" && isKnownNonPlainFactory(nodeProp(node, "callee"))) {
    return true;
  }
  if (node.type === "ObjectExpression") {
    return nodeArray(node, "properties").some((property) => {
      if (property.type === "SpreadElement") {
        return false;
      }
      const value = nodeProp(property, "value");
      return value ? containsObviouslyNonPlainArg(value) : false;
    });
  }
  if (node.type === "ArrayExpression") {
    return nodeArray(node, "elements").some(containsObviouslyNonPlainArg);
  }
  return false;
}

function isKnownNonPlainFactory(callee: AstNode | undefined): boolean {
  return isIdentifier(callee) && ["Map", "Set", "Date"].includes(identifierName(callee));
}

function isIdentifier(
  node: AstNode | undefined,
): node is AstNode & { readonly type: "Identifier" } {
  return node?.type === "Identifier" && typeof node["name"] === "string";
}

function identifierName(node: AstNode & { readonly type: "Identifier" }): string {
  return node["name"] as string;
}

function nodeProp(node: AstNode | undefined, key: string): AstNode | undefined {
  const value = node?.[key];
  return isNode(value) ? value : undefined;
}

function nodeArray(node: AstNode | undefined, key: string): AstNode[] {
  const value = node?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isNode);
}

function stringProp(node: AstNode, key: string): string | undefined {
  const value = node[key];
  return typeof value === "string" ? value : undefined;
}

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly type?: unknown }).type === "string"
  );
}
