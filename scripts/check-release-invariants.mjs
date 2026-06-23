import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const packagesDir = new URL("../packages/", import.meta.url);
const dependencyFields = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
];
const repositoryUrl = "https://github.com/PluxelJS/GQLens";

const packageJsons = await readWorkspacePackages();
const publicPackages = packageJsons.filter((pkg) => pkg.name?.startsWith("@gqlens/"));
const versions = new Map(publicPackages.map((pkg) => [pkg.name, pkg.version]));
const uniqueVersions = new Set(versions.values());
const errors = [];

if (publicPackages.length === 0) {
  errors.push("No @gqlens/* packages found under packages/.");
}

if (uniqueVersions.size > 1) {
  errors.push(
    `All @gqlens/* packages must share one version. Found: ${[...versions]
      .map(([name, version]) => `${name}@${version}`)
      .join(", ")}`,
  );
}

const [workspaceVersion] = uniqueVersions;

for (const pkg of publicPackages) {
  if (pkg.repository?.url !== repositoryUrl) {
    errors.push(`${pkg.name} repository.url must be ${repositoryUrl}.`);
  }

  for (const field of dependencyFields) {
    const dependencies = pkg[field];
    if (!dependencies || typeof dependencies !== "object") {
      continue;
    }

    for (const [name, range] of Object.entries(dependencies)) {
      if (!versions.has(name)) {
        continue;
      }
      if (range === "workspace:*" || range === workspaceVersion) {
        continue;
      }
      errors.push(
        `${pkg.name} ${field}.${name} must be workspace:* in source or ${workspaceVersion} in a packed manifest, got ${range}.`,
      );
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exitCode = 1;
} else {
  console.log(`Release invariants OK: ${publicPackages.length} packages at ${workspaceVersion}.`);
}

async function readWorkspacePackages() {
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const packages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = join(packagesDir.pathname, entry.name, "package.json");
    packages.push(JSON.parse(await readFile(file, "utf8")));
  }

  return packages.toSorted((a, b) => String(a.name).localeCompare(String(b.name)));
}
