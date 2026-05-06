#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const publicPackageDirs = [
  "packages/contracts",
  "packages/pglite-sync",
  "packages/sync-engine",
  "packages/client",
  "packages/server",
] as const;

interface PackageManifest {
  main?: unknown;
  exports?: unknown;
}

function normalizeManifestPath(value: string): string {
  return value.replace(/^\.\//, "").replaceAll("\\", "/");
}

function collectExportRuntimePaths(value: unknown, key?: string): string[] {
  if (typeof value === "string") {
    return key === "types" ? [] : [normalizeManifestPath(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectExportRuntimePaths(item, key));
  }

  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    return Object.entries(objectValue).flatMap(([childKey, childValue]) =>
      collectExportRuntimePaths(childValue, childKey),
    );
  }

  return [];
}

function readRuntimeEntryPaths(packagePath: string): string[] {
  const manifestPath = resolve(packagePath, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
  const runtimePaths = new Set<string>();

  if (typeof manifest.main === "string") {
    runtimePaths.add(normalizeManifestPath(manifest.main));
  }

  for (const exportPath of collectExportRuntimePaths(manifest.exports)) {
    runtimePaths.add(exportPath);
  }

  return [...runtimePaths].filter((entryPath) => entryPath.endsWith(".js") || entryPath.endsWith(".mjs"));
}

function verifyRuntimeFilesExist(packageDir: string, packagePath: string): string[] {
  const runtimeEntryPaths = readRuntimeEntryPaths(packagePath);

  if (runtimeEntryPaths.length === 0) {
    throw new Error(`No runtime entrypoints were discovered for ${packageDir}`);
  }

  for (const entryPath of runtimeEntryPaths) {
    const absoluteEntryPath = resolve(packagePath, entryPath);
    if (!existsSync(absoluteEntryPath)) {
      throw new Error(`Missing runtime entrypoint for ${packageDir}: ${entryPath}`);
    }
  }

  return runtimeEntryPaths;
}

function listTarEntries(tarballPath: string): Set<string> {
  const result = spawnSync("tar", ["-tzf", tarballPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`Failed to read tarball entries: ${tarballPath}`);
  }

  return new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

function verifyTarballRuntimeEntries(packageDir: string, tarballPath: string, runtimeEntryPaths: string[]): void {
  const tarEntries = listTarEntries(tarballPath);

  for (const entryPath of runtimeEntryPaths) {
    const tarEntryPath = `package/${entryPath}`;
    if (!tarEntries.has(tarEntryPath)) {
      throw new Error(`Tarball for ${packageDir} is missing runtime entrypoint: ${tarEntryPath}`);
    }
  }
}

for (const packageDir of publicPackageDirs) {
  const packagePath = resolve(repoRoot, packageDir);
  const runtimeEntryPaths = verifyRuntimeFilesExist(packageDir, packagePath);
  console.log(`Packing ${packageDir} for release verification`);
  const filesBefore = new Set(readdirSync(packagePath));

  const result = spawnSync("bun", ["pm", "pack", "--quiet"], {
    cwd: packagePath,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`Pack verification failed for ${packageDir}`);
  }

  const newTarballs = readdirSync(packagePath).filter(
    (fileName) => fileName.endsWith(".tgz") && !filesBefore.has(fileName),
  );

  if (newTarballs.length !== 1) {
    throw new Error(`Expected exactly one tarball for ${packageDir}, found ${newTarballs.length}`);
  }

  const tarballPath = resolve(packagePath, newTarballs[0]!);
  verifyTarballRuntimeEntries(packageDir, tarballPath, runtimeEntryPaths);

  for (const fileName of readdirSync(packagePath)) {
    if (filesBefore.has(fileName)) {
      continue;
    }

    if (fileName.endsWith(".tgz")) {
      rmSync(resolve(packagePath, fileName), { force: true });
    }
  }
}

console.log("Release pack verification succeeded for all public packages.");
