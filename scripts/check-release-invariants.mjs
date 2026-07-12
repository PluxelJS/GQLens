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
const releaseLines = new Map(
  publicPackages.map((pkg) => [pkg.name, parseReleaseLine(pkg.version)]),
);
const uniqueReleaseLines = new Set(releaseLines.values());
const errors = [];

if (publicPackages.length === 0) {
  errors.push("No @gqlens/* packages found under packages/.");
}

for (const pkg of publicPackages) {
  if (!releaseLines.get(pkg.name)) {
    errors.push(`${pkg.name} version must be valid semver, got ${pkg.version}.`);
  }
}

if (uniqueReleaseLines.size > 1) {
  errors.push(
    `All @gqlens/* packages must share one major.minor release line. Found: ${[...versions]
      .map(([name, version]) => `${name}@${version}`)
      .join(", ")}`,
  );
}

const [workspaceReleaseLine] = uniqueReleaseLines;

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
      if (range === "workspace:*" || range === versions.get(name)) {
        continue;
      }
      errors.push(
        `${pkg.name} ${field}.${name} must be workspace:* in source or ${versions.get(name)} in a packed manifest, got ${range}.`,
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
  console.log(
    `Release invariants OK: ${publicPackages.length} packages on ${workspaceReleaseLine}.x.`,
  );
}

function parseReleaseLine(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(version),
  );
  if (!match) {
    return undefined;
  }
  return `${match[1]}.${match[2]}`;
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
