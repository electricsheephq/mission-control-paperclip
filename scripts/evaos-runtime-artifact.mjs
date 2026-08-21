#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PLATFORM = "linux-x64";
const EMBEDDED_POSTGRES_LINUX_PACKAGE = "@embedded-postgres/linux-x64";
const EMBEDDED_POSTGRES_NATIVE_ALIASES = [
  ["libcrypto.so.1.1", "libcrypto.so.1"],
  ["libssl.so.1.1", "libssl.so.1"],
];

function usage() {
  return `Usage:
  scripts/build-evaos-runtime-artifact.sh --version VERSION --out-dir DIR [options]
  node scripts/evaos-runtime-artifact.mjs patch-versions PACKAGE_ROOT VERSION
  node scripts/evaos-runtime-artifact.mjs link-cli-externals PACKAGE_ROOT EXTERNAL...
  node scripts/evaos-runtime-artifact.mjs hydrate-embedded-postgres-native PACKAGE_ROOT
  node scripts/evaos-runtime-artifact.mjs write-manifest OUT VERSION SOURCE_REF SOURCE_SHA ARTIFACT SHA256
`;
}

export function artifactFileName(version) {
  return `evaos-paperclip-runtime-${version}-${PLATFORM}.tgz`;
}

export function parseArtifactArgs(argv) {
  const parsed = {
    help: false,
    version: "",
    outDir: "",
    sourceRef: "",
    skipBuild: false,
    skipSmoke: false,
    keepStage: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
    } else if (arg === "--version") {
      parsed.version = argv[++index] ?? "";
    } else if (arg === "--out-dir") {
      parsed.outDir = argv[++index] ?? "";
    } else if (arg === "--source-ref") {
      parsed.sourceRef = argv[++index] ?? "";
    } else if (arg === "--skip-build") {
      parsed.skipBuild = true;
    } else if (arg === "--skip-smoke") {
      parsed.skipSmoke = true;
    } else if (arg === "--keep-stage") {
      parsed.keepStage = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (parsed.help) {
    return parsed;
  }
  if (!parsed.version) {
    throw new Error("--version is required");
  }
  if (!/^[0-9A-Za-z._-]+$/.test(parsed.version)) {
    throw new Error(`invalid version: ${parsed.version}`);
  }
  if (!parsed.outDir) {
    throw new Error("--out-dir is required");
  }
  if (!parsed.sourceRef) {
    parsed.sourceRef = "HEAD";
  }
  if (!/^[0-9A-Za-z._/@+-]+$/.test(parsed.sourceRef)) {
    throw new Error(`invalid source ref: ${parsed.sourceRef}`);
  }

  return parsed;
}

export function createArtifactManifest({
  version,
  sourceRef,
  sourceSha,
  artifactName,
  sha256,
}) {
  return {
    schema: 1,
    name: "evaos-paperclip-runtime",
    version,
    platform: PLATFORM,
    sourceRef,
    sourceSha,
    artifact: artifactName,
    sha256,
    installPackageRoot: "paperclipai",
    bin: "dist/index.js",
  };
}

function rewritePaperclipDependencyVersions(pkg, version) {
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = pkg[field];
    if (!deps || typeof deps !== "object") continue;
    for (const name of Object.keys(deps)) {
      if (name === "paperclipai" || name.startsWith("@paperclipai/")) {
        deps[name] = version;
      }
    }
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isPathInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function materializeExternalPackageRoot(packageDir, installRoot) {
  const packageDirReal = await realpath(packageDir);
  const installRootReal = await realpath(installRoot);
  if (isPathInside(packageDirReal, installRootReal)) return;

  const tempDir = `${packageDir}.runtime-${process.pid}-${Date.now()}`;
  await rm(tempDir, { recursive: true, force: true });
  await cp(packageDirReal, tempDir, { recursive: true, dereference: true });
  await rm(packageDir, { recursive: true, force: true });
  await rename(tempDir, packageDir);
}

async function breakPackageJsonHardlink(filePath) {
  const tempPath = `${filePath}.runtime-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, await readFile(filePath, "utf8"));
  await rename(tempPath, filePath);
}

async function patchPackageJson(filePath, version, installRoot) {
  await materializeExternalPackageRoot(path.dirname(filePath), installRoot);
  await breakPackageJsonHardlink(filePath);
  const pkg = JSON.parse(await readFile(filePath, "utf8"));
  if (pkg.name === "paperclipai" || String(pkg.name ?? "").startsWith("@paperclipai/")) {
    pkg.version = version;
    applyPublishConfigRuntimeMetadata(pkg);
  }
  rewritePaperclipDependencyVersions(pkg, version);
  await writeJson(filePath, pkg);
}

function applyPublishConfigRuntimeMetadata(pkg) {
  const publishConfig = pkg.publishConfig;
  if (!publishConfig || typeof publishConfig !== "object") return;

  if (Object.hasOwn(publishConfig, "exports")) {
    pkg.exports = publishConfig.exports;
  }
  for (const field of ["main", "module", "types"]) {
    if (Object.hasOwn(publishConfig, field)) {
      pkg[field] = publishConfig[field];
    }
  }
}

async function listScopedPaperclipPackageJsons(packageRoot) {
  const scopedRoot = path.join(packageRoot, "node_modules", "@paperclipai");
  const entries = [];
  try {
    for (const entry of await readdir(scopedRoot, { withFileTypes: true })) {
      const packageRoot = path.join(scopedRoot, entry.name);
      const packageJson = path.join(packageRoot, "package.json");
      try {
        const packageStat = await stat(packageRoot);
        if (packageStat.isDirectory() && await pathExists(packageJson)) {
          entries.push(packageJson);
        }
      } catch (err) {
        if (err?.code !== "ENOENT") {
          throw err;
        }
      }
    }
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }
  return entries;
}

export async function patchDeployedPackageVersions(packageRoot, version) {
  const rootStat = await stat(packageRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`package root is not a directory: ${packageRoot}`);
  }
  const packageJsons = [
    path.join(packageRoot, "package.json"),
    ...(await listScopedPaperclipPackageJsons(packageRoot)),
  ];
  for (const packageJson of packageJsons) {
    await patchPackageJson(packageJson, version, packageRoot);
  }
}

async function pathExists(filePath, { followSymlink = true } = {}) {
  try {
    await (followSymlink ? stat(filePath) : lstat(filePath));
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function nodeModulePackagePath(nodeModulesPath, packageName) {
  return path.join(nodeModulesPath, ...packageName.split("/"));
}

async function findDeployedDependencyRoot(packageRoot, packageName) {
  const nodeModulesPath = path.join(packageRoot, "node_modules");
  const directPath = nodeModulePackagePath(nodeModulesPath, packageName);
  if (await pathExists(directPath)) {
    return directPath;
  }

  const pnpmStorePath = path.join(nodeModulesPath, ".pnpm");
  const entries = await readdir(pnpmStorePath, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const candidate = nodeModulePackagePath(
      path.join(pnpmStorePath, entry.name, "node_modules"),
      packageName,
    );
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(`deployed dependency not found for CLI external: ${packageName}`);
}

export async function linkCliRuntimeExternals(packageRoot, externals) {
  const rootStat = await stat(packageRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`package root is not a directory: ${packageRoot}`);
  }

  const nodeModulesPath = path.join(packageRoot, "node_modules");
  const linked = [];
  for (const packageName of [...new Set(externals)].sort()) {
    if (!packageName || packageName.startsWith("node:")) continue;

    const directPath = nodeModulePackagePath(nodeModulesPath, packageName);
    if (await pathExists(directPath, { followSymlink: false })) {
      continue;
    }

    const targetPath = await findDeployedDependencyRoot(packageRoot, packageName);
    await mkdir(path.dirname(directPath), { recursive: true });
    await symlink(path.relative(path.dirname(directPath), targetPath), directPath);
    linked.push(packageName);
  }
  return linked;
}

async function ensureRelativeSymlink(sourcePath, targetPath) {
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) {
    throw new Error(`symlink source is not a file: ${sourcePath}`);
  }

  const relativeSource = path.relative(path.dirname(targetPath), sourcePath);
  const existing = await lstat(targetPath).catch((err) => {
    if (err?.code === "ENOENT") return null;
    throw err;
  });
  if (existing) {
    if (!existing.isSymbolicLink()) return false;
    const currentTarget = await readlink(targetPath);
    if (currentTarget === relativeSource) return false;
    await rm(targetPath);
  }

  await symlink(relativeSource, targetPath);
  return true;
}

async function hydrateEmbeddedPostgresManifestSymlinks(packageRoot) {
  const manifestPath = path.join(packageRoot, "native", "pg-symlinks.json");
  let raw;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }

  const created = [];
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries)) {
    throw new Error(`embedded Postgres symlink manifest is not an array: ${manifestPath}`);
  }

  for (const entry of entries) {
    if (!entry || typeof entry.source !== "string" || typeof entry.target !== "string") {
      throw new Error(`embedded Postgres symlink manifest contains an invalid entry: ${manifestPath}`);
    }
    const sourcePath = path.join(packageRoot, entry.source);
    const targetPath = path.join(packageRoot, entry.target);
    if (await ensureRelativeSymlink(sourcePath, targetPath)) {
      created.push(entry.target);
    }
  }
  return created;
}

async function ensureEmbeddedPostgresNativeAliases(packageRoot) {
  const nativeLibRoot = path.join(packageRoot, "native", "lib");
  const created = [];
  for (const [sourceName, targetName] of EMBEDDED_POSTGRES_NATIVE_ALIASES) {
    const sourcePath = path.join(nativeLibRoot, sourceName);
    const targetPath = path.join(nativeLibRoot, targetName);
    if (await ensureRelativeSymlink(sourcePath, targetPath)) {
      created.push(path.join("native", "lib", targetName));
    }
  }
  return created;
}

export async function hydrateEmbeddedPostgresNativeSymlinks(packageRoot) {
  const dependencyRoot = await findDeployedDependencyRoot(packageRoot, EMBEDDED_POSTGRES_LINUX_PACKAGE);
  return {
    packageRoot: dependencyRoot,
    manifestSymlinks: await hydrateEmbeddedPostgresManifestSymlinks(dependencyRoot),
    nativeAliases: await ensureEmbeddedPostgresNativeAliases(dependencyRoot),
  };
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") {
    console.log(usage());
    return;
  }
  if (command === "artifact-name") {
    const args = parseArtifactArgs(rest);
    console.log(artifactFileName(args.version));
    return;
  }
  if (command === "patch-versions") {
    const [packageRoot, version] = rest;
    if (!packageRoot || !version) {
      throw new Error("patch-versions requires PACKAGE_ROOT and VERSION");
    }
    await patchDeployedPackageVersions(packageRoot, version);
    return;
  }
  if (command === "link-cli-externals") {
    const [packageRoot, ...externals] = rest;
    if (!packageRoot || externals.length === 0) {
      throw new Error("link-cli-externals requires PACKAGE_ROOT and at least one EXTERNAL");
    }
    await linkCliRuntimeExternals(packageRoot, externals);
    return;
  }
  if (command === "hydrate-embedded-postgres-native") {
    const [packageRoot] = rest;
    if (!packageRoot) {
      throw new Error("hydrate-embedded-postgres-native requires PACKAGE_ROOT");
    }
    const result = await hydrateEmbeddedPostgresNativeSymlinks(packageRoot);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "sha256") {
    const [filePath] = rest;
    if (!filePath) {
      throw new Error("sha256 requires FILE");
    }
    console.log(await sha256File(filePath));
    return;
  }
  if (command === "write-manifest") {
    const [outPath, version, sourceRef, sourceSha, artifactName, sha256] = rest;
    if (!outPath || !version || !sourceRef || !sourceSha || !artifactName || !sha256) {
      throw new Error("write-manifest requires OUT VERSION SOURCE_REF SOURCE_SHA ARTIFACT SHA256");
    }
    await writeJson(outPath, createArtifactManifest({
      version,
      sourceRef,
      sourceSha,
      artifactName,
      sha256,
    }));
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
