import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer, type ViteDevServer } from "vite";
import { afterEach, expect, test } from "vitest";
import { gqlens } from "../src/index";

const fixtureRoots = new Set<string>();
const entryHelper = JSON.stringify(fileURLToPath(new URL("../src/entry.ts", import.meta.url)));

afterEach(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { recursive: true, force: true })));
  fixtureRoots.clear();
});

test("generates files during vite build", async () => {
  const root = await createFixture();

  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [gqlens({ entry: "/src/graphql-entry.ts", output: "web/gqlens" })],
  });

  const types = await readFile(join(root, "web/gqlens/types.ts"), "utf8");
  expect(types).toContain("Viewer");
  expect(types).toContain("name");
});

test("refreshes generated files and middleware through vite dev hmr", async () => {
  const root = await createFixture();
  const server = await createServer({
    root,
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [gqlens({ entry: "/src/graphql-entry.ts", output: "web/gqlens" })],
  });

  try {
    await server.listen(0);
    const baseUrl = localServerUrl(server);

    expect(await viewerName(baseUrl)).toBe("Ada");

    await writeFile(join(root, "src/handler.ts"), handlerSource("Grace"), "utf8");
    await waitUntil(async () => (await viewerName(baseUrl)) === "Grace");
    expect(await viewerName(baseUrl)).toBe("Grace");

    await writeFile(join(root, "src/schema.ts"), schemaSource("  nickname: String!\n"), "utf8");
    await waitUntil(async () =>
      (await readFile(join(root, "web/gqlens/types.ts"), "utf8")).includes("nickname"),
    );
    const types = await readFile(join(root, "web/gqlens/types.ts"), "utf8");
    expect(types).toContain("nickname");
  } finally {
    await closeServer(server);
  }
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gqlens-vite-"));
  fixtureRoots.add(root);
  await mkdir(join(root, "src"), { recursive: true });

  await Promise.all([
    writeFile(join(root, "index.html"), '<script type="module" src="/src/main.ts"></script>'),
    writeFile(join(root, "src/main.ts"), "export {};\n"),
    writeFile(join(root, "src/schema.ts"), schemaSource(""), "utf8"),
    writeFile(join(root, "src/handler.ts"), handlerSource("Ada"), "utf8"),
    writeFile(join(root, "src/graphql-entry.ts"), entrySource(), "utf8"),
  ]);

  return root;
}

function entrySource(): string {
  return `import { defineGQLensEntry } from ${entryHelper};
import { schema } from "./schema.ts";

export default defineGQLensEntry({
  schema,
  handler: async (server) => {
    const mod = await server.ssrLoadModule("/src/handler.ts");
    return mod.createHandler();
  },
});
`;
}

function schemaSource(extraViewerFields: string): string {
  return `export function schema() {
  return \`
type Query {
  viewer: Viewer!
}

type Viewer {
  id: ID!
  name: String!
${extraViewerFields}}\`;
}
`;
}

function handlerSource(name: string): string {
  return `export function createHandler() {
  return async (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(${JSON.stringify(JSON.stringify({ data: { viewer: { id: "u1", name } } }))});
  };
}
`;
}

async function viewerName(baseUrl: string): Promise<string> {
  const response = await fetch(new URL("graphql", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "query { viewer { id name } }" }),
  });
  const body = (await response.json()) as { data: { viewer: { name: string } } };
  return body.data.viewer.name;
}

function localServerUrl(server: ViteDevServer): string {
  const baseUrl = server.resolvedUrls?.local[0];
  if (!baseUrl) {
    throw new Error("Vite dev server did not expose a local URL.");
  }
  return baseUrl;
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  await pollUntil(predicate, Date.now() + 10_000);
}

async function pollUntil(predicate: () => Promise<boolean>, deadline: number): Promise<void> {
  if (await predicate()) {
    return;
  }
  if (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await pollUntil(predicate, deadline);
    return;
  }

  throw new Error("Timed out waiting for Vite update.");
}

async function closeServer(server: ViteDevServer): Promise<void> {
  await server.close();
}
