#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PLATFORM = "linux-x64";

function usage() {
  return `Usage:
  scripts/build-evaos-runtime-artifact.sh --version VERSION --out-dir DIR [options]
  node scripts/evaos-runtime-artifact.mjs patch-versions PACKAGE_ROOT VERSION
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

async function patchPackageJson(filePath, version) {
  const pkg = JSON.parse(await readFile(filePath, "utf8"));
  if (pkg.name === "paperclipai" || String(pkg.name ?? "").startsWith("@paperclipai/")) {
    pkg.version = version;
  }
  rewritePaperclipDependencyVersions(pkg, version);
  await writeJson(filePath, pkg);
}

async function listScopedPaperclipPackageJsons(packageRoot) {
  const scopedRoot = path.join(packageRoot, "node_modules", "@paperclipai");
  const entries = [];
  try {
    for (const entry of await readdir(scopedRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        entries.push(path.join(scopedRoot, entry.name, "package.json"));
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
    await patchPackageJson(packageJson, version);
  }
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
