import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import plugin from "../src/index";

RuleTester.describe = describe;
RuleTester.it = it;

type TestRule = Parameters<RuleTester["run"]>[1];

const rules = plugin.rules as unknown as Readonly<Record<string, TestRule>>;
const tester = new RuleTester();

function rule(name: string): TestRule {
  const value = rules[name];
  if (!value) {
    throw new Error(`Missing GQLens oxlint rule: ${name}`);
  }
  return value;
}

tester.run("gqlens/no-untracked-read", rule("no-untracked-read"), {
  valid: [
    `
      function UserName() {
        const q = useQuery();
        return q.user({ id }).name;
      }
    `,
  ],
  invalid: [
    {
      code: `
        function UserName() {
          const q = useQuery();
          const onClick = () => q.user({ id }).name;
          return onClick;
        }
      `,
      errors: ["Read GQLens fields in render or an explicit selector context."],
    },
  ],
});

tester.run("gqlens/no-accessor-object-ops", rule("no-accessor-object-ops"), {
  valid: [
    `
      function UserName() {
        const q = createQuery();
        return q.viewer.name;
      }
    `,
  ],
  invalid: [
    {
      code: `
        function UserName() {
          const q = createQuery();
          return Object.keys(q.viewer);
        }
      `,
      errors: ["Do not use object operations on a GQLens accessor."],
    },
  ],
});

tester.run("gqlens/selector-pure", rule("selector-pure"), {
  valid: [
    `
      const userCard = defineSelection((q, v) => {
        q.user({ id: v("id") }).name;
        q.user({ id: v("id") }).avatar;
      });
    `,
  ],
  invalid: [
    {
      code: `
        const userCard = defineSelection((q, v) => {
          const readName = () => q.user({ id: v("id") }).name;
          readName();
        });
      `,
      errors: [
        "Do not create nested functions inside GQLens selectors.",
        "Only accessor calls and variable placeholders are allowed here.",
      ],
    },
  ],
});

tester.run("gqlens/plain-args", rule("plain-args"), {
  valid: [
    `
      function Todos() {
        const q = createQuery();
        return q.todos({ done: false }).ids;
      }
    `,
  ],
  invalid: [
    {
      code: `
        function Events() {
          const q = createQuery();
          return q.events({ after: new Date() }).ids;
        }
      `,
      errors: ["Use plain GraphQL input values for GQLens args."],
    },
  ],
});
