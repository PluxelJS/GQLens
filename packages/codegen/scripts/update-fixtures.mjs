import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateFiles } from "../dist/index.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturesRoot = join(packageRoot, "test", "fixtures");

const fixtureNames = (await readdir(fixturesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

await Promise.all(fixtureNames.map(updateFixture));

async function updateFixture(fixtureName) {
  const fixtureDir = join(fixturesRoot, fixtureName);
  const schema = await readFile(join(fixtureDir, "schema.graphql"), "utf8");
  const files = await generateFiles({ schema });

  await Promise.all(
    Object.entries(files).map(([fileName, content]) =>
      writeFile(join(fixtureDir, fileName), content, "utf8"),
    ),
  );
}
