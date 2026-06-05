import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writeGeneratedFiles(
  files: Readonly<Record<string, string>>,
  output: string,
): Promise<boolean> {
  const changed = await Promise.all(
    Object.entries(files).map(([name, content]) => writeIfChanged(join(output, name), content)),
  );
  return changed.some(Boolean);
}

async function writeIfChanged(file: string, content: string): Promise<boolean> {
  if ((await readExisting(file)) === content) {
    return false;
  }

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return true;
}

async function readExisting(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}
