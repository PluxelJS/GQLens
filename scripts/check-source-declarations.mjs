import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const ignoredDirectories = new Set([".git", ".vercel", "dist", "node_modules", "public"]);
const declarationPattern = /\.d\.[cm]?ts$/;
const declarationMapPattern = /\.d\.[cm]?ts\.map$/;

const declarations = await declarationFiles(root, false);
const unexpected = declarations
  .map((path) => relative(root, path).replaceAll("\\", "/"))
  .toSorted();

if (unexpected.length > 0) {
  process.stderr.write(
    `Unexpected generated declarations outside build output:\n- ${unexpected.join("\n- ")}\n` +
      "Declaration builds must keep intermediate output in dist or a disposable cache.\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Source declaration check passed\n");
}

async function declarationFiles(directory, insideSource) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) {
          return [];
        }
        return declarationFiles(path, insideSource || entry.name === "src");
      }
      return declarationMapPattern.test(entry.name) ||
        (insideSource && declarationPattern.test(entry.name))
        ? [path]
        : [];
    }),
  );
  return nested.flat();
}
