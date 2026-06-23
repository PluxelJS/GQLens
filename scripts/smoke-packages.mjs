import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url).pathname;
const temp = await mkdtemp(join(tmpdir(), "gqlens-smoke-"));
const tarballDir = join(temp, "tarballs");
const consumerDir = join(temp, "consumer");

try {
  const packages = [
    "@gqlens/core",
    "@gqlens/codegen",
    "@gqlens/vite",
    "@gqlens/react",
    "@gqlens/solid",
  ];
  const tarballs = {};

  for (const name of packages) {
    const output = execFileSync(
      "pnpm",
      ["--filter", name, "pack", "--pack-destination", tarballDir, "--json"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    const packed = JSON.parse(output);
    tarballs[name] = `file:${packed.filename}`;
  }

  await writeFile(
    join(temp, "consumer-package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          ...tarballs,
          graphql: "^16",
          react: "^19",
          "react-dom": "^19",
          "solid-js": "^1",
          vite: "^8",
        },
        devDependencies: {
          typescript: "^6",
          "@types/node": "^25",
          "@types/react": "^19",
          "@types/react-dom": "^19",
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  await mkdir(consumerDir, { recursive: true });
  await rename(join(temp, "consumer-package.json"), join(consumerDir, "package.json"));
  await writeFile(
    join(consumerDir, "pnpm-workspace.yaml"),
    [
      "overrides:",
      ...Object.entries(tarballs).map(
        ([name, tarball]) => `  ${JSON.stringify(name)}: ${JSON.stringify(tarball)}`,
      ),
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    join(consumerDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ESNext",
          lib: ["ESNext", "DOM"],
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          verbatimModuleSyntax: true,
        },
        include: ["index.tsx"],
      },
      null,
      2,
    ),
    "utf8",
  );

  await writeFile(
    join(consumerDir, "index.tsx"),
    [
      'import { createGraphDataStore, bindSelection, type PreparedSelection } from "@gqlens/core";',
      'import { createAccessorNode } from "@gqlens/core/codegen";',
      'import { generateFiles } from "@gqlens/codegen";',
      'import { gqlens } from "@gqlens/vite";',
      'import { defineGQLensEntry } from "@gqlens/vite/entry";',
      'import { GQLensProvider, useQuery } from "@gqlens/react";',
      'import { createQuery } from "@gqlens/solid";',
      'import { createElement } from "react";',
      "",
      "const store = createGraphDataStore();",
      "const selection: PreparedSelection = { variables: [], paths: [] };",
      "bindSelection(selection, {});",
      "void store;",
      "void createAccessorNode;",
      'void generateFiles({ schema: "type Query { ok: Boolean }" });',
      'gqlens({ entry: "src/graphql-entry.ts", output: "src/generated" });',
      'defineGQLensEntry({ schema: () => "type Query { ok: Boolean }" });',
      "createElement(GQLensProvider, { config: {}, children: null });",
      "void useQuery;",
      "void createQuery;",
      "",
    ].join("\n"),
    "utf8",
  );

  execFileSync("pnpm", ["install", "--ignore-scripts"], {
    cwd: consumerDir,
    stdio: "inherit",
  });
  execFileSync("pnpm", ["exec", "tsc", "--noEmit"], {
    cwd: consumerDir,
    stdio: "inherit",
  });

  const files = await readdir(tarballDir);
  console.log(`Package smoke test OK: ${files.length} tarballs installed and type-checked.`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
