import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface GeneratedWriteStats {
  readonly total: number;
  readonly changed: number;
  readonly skipped: number;
}

export async function writeGeneratedFiles(
  files: Readonly<Record<string, string>>,
  output: string,
): Promise<GeneratedWriteStats> {
  const changed = await Promise.all(
    Object.entries(files).map(([name, content]) => writeIfChanged(join(output, name), content)),
  );
  const changedCount = changed.filter(Boolean).length;
  return {
    total: changed.length,
    changed: changedCount,
    skipped: changed.length - changedCount,
  };
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
