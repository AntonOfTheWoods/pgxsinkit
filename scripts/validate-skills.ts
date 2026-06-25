import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

// Validate every workspace package's Agent Skills (`skills/**/SKILL.md`) with the @tanstack/intent CLI.
//
// Invokes the CLI by its explicit resolved path on purpose: `@electric-sql/client` also ships an
// `intent` binary, so `bunx @tanstack/intent` / the `.bin/intent` shim can resolve to the wrong one from
// inside a package that has Electric installed. The explicit path is unambiguous. Each package is
// validated with its own directory as cwd so the CLI's packaging checks read that package's package.json.

const root = process.cwd();
const cli = path.join(root, "node_modules/@tanstack/intent/dist/cli.mjs");
if (!existsSync(cli)) {
  console.error("@tanstack/intent is not installed (expected at node_modules/@tanstack/intent). Run `bun install`.");
  process.exit(1);
}

const packagesDir = path.join(root, "packages");
const packagesWithSkills = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(packagesDir, entry.name, "skills")))
  .map((entry) => entry.name)
  .sort();

if (packagesWithSkills.length === 0) {
  console.log("No packages ship a skills/ directory.");
  process.exit(0);
}

let anyFailed = false;
for (const pkg of packagesWithSkills) {
  console.log(`\n=== packages/${pkg} ===`);
  const result = spawnSync("bun", [cli, "validate"], { cwd: path.join(packagesDir, pkg), stdio: "inherit" });
  if (result.status !== 0) anyFailed = true;
}

process.exit(anyFailed ? 1 : 0);
