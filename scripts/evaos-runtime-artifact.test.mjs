import assert from "node:assert/strict";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactFileName,
  createArtifactManifest,
  linkCliRuntimeExternals,
  parseArtifactArgs,
  patchDeployedPackageVersions,
} from "./evaos-runtime-artifact.mjs";

test("parseArtifactArgs requires a version and output directory", () => {
  assert.deepEqual(
    parseArtifactArgs([
      "--version",
      "2026.522.0-canary.0",
      "--out-dir",
      "/tmp/evaos",
      "--source-ref",
      "5e99b8c1",
      "--skip-build",
    ]),
    {
      help: false,
      version: "2026.522.0-canary.0",
      outDir: "/tmp/evaos",
      sourceRef: "5e99b8c1",
      skipBuild: true,
      skipSmoke: false,
      keepStage: false,
    },
  );

  assert.throws(
    () => parseArtifactArgs(["--version", "2026.522.0-canary.0"]),
    /--out-dir is required/,
  );
});

test("parseArtifactArgs rejects unsafe source refs", () => {
  assert.throws(
    () => parseArtifactArgs([
      "--version",
      "2026.522.0-canary.0",
      "--out-dir",
      "/tmp/evaos",
      "--source-ref",
      "main;echo bad",
    ]),
    /invalid source ref/,
  );
});

test("artifactFileName uses the evaOS runtime naming convention", () => {
  assert.equal(
    artifactFileName("2026.522.0-canary.0"),
    "evaos-paperclip-runtime-2026.522.0-canary.0-linux-x64.tgz",
  );
});

test("createArtifactManifest records source and checksum metadata", () => {
  assert.deepEqual(createArtifactManifest({
    version: "2026.522.0-canary.0",
    sourceRef: "master",
    sourceSha: "5e99b8c1",
    artifactName: "evaos-paperclip-runtime-2026.522.0-canary.0-linux-x64.tgz",
    sha256: "a".repeat(64),
  }), {
    schema: 1,
    name: "evaos-paperclip-runtime",
    version: "2026.522.0-canary.0",
    platform: "linux-x64",
    sourceRef: "master",
    sourceSha: "5e99b8c1",
    artifact: "evaos-paperclip-runtime-2026.522.0-canary.0-linux-x64.tgz",
    sha256: "a".repeat(64),
    installPackageRoot: "paperclipai",
    bin: "dist/index.js",
  });
});

test("linkCliRuntimeExternals links bundled CLI externals from deployed pnpm tree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-evaos-links-"));
  const packageRoot = path.join(root, "paperclipai");
  const zodRoot = path.join(packageRoot, "node_modules", ".pnpm", "zod@3.25.76", "node_modules", "zod");
  const serverRoot = path.join(packageRoot, "node_modules", "@paperclipai", "server");

  try {
    await mkdir(zodRoot, { recursive: true });
    await mkdir(serverRoot, { recursive: true });
    await writeFile(path.join(zodRoot, "package.json"), "{}");
    await writeFile(path.join(serverRoot, "package.json"), "{}");

    const linked = await linkCliRuntimeExternals(packageRoot, [
      "zod",
      "@paperclipai/server",
      "zod",
    ]);

    assert.deepEqual(linked, ["zod"]);
    const linkPath = path.join(packageRoot, "node_modules", "zod");
    assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
    assert.equal(
      path.resolve(path.dirname(linkPath), await readlink(linkPath)),
      zodRoot,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("patchDeployedPackageVersions rewrites the deployed package tree only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-evaos-artifact-"));
  const packageRoot = path.join(root, "paperclipai");
  const adapterRoot = path.join(packageRoot, "node_modules", "@paperclipai", "adapter-openclaw-gateway");
  const sourceServerPackageJson = path.join(root, "server-package.json");
  const serverStoreRoot = path.join(
    packageRoot,
    "node_modules",
    ".pnpm",
    "@paperclipai+server@file+server_hash",
    "node_modules",
    "@paperclipai",
    "server",
  );
  const serverLinkRoot = path.join(packageRoot, "node_modules", "@paperclipai", "server");

  try {
    await mkdir(adapterRoot, { recursive: true });
    await mkdir(serverStoreRoot, { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "paperclipai",
      version: "0.3.1",
      dependencies: {
        "@paperclipai/adapter-openclaw-gateway": "workspace:*",
        "@paperclipai/server": "workspace:*",
        "picocolors": "^1.1.1",
      },
    }, null, 2));
    await writeFile(path.join(adapterRoot, "package.json"), JSON.stringify({
      name: "@paperclipai/adapter-openclaw-gateway",
      version: "0.3.1",
      dependencies: {
        "@paperclipai/adapter-utils": "workspace:*",
      },
    }, null, 2));
    await writeFile(sourceServerPackageJson, JSON.stringify({
      name: "@paperclipai/server",
      version: "0.3.1",
      exports: {
        ".": "./src/index.ts",
      },
      publishConfig: {
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            import: "./dist/index.js",
          },
        },
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
      dependencies: {
        "@paperclipai/adapter-openclaw-gateway": "workspace:*",
      },
    }, null, 2));
    await link(sourceServerPackageJson, path.join(serverStoreRoot, "package.json"));
    await symlink(
      path.relative(path.dirname(serverLinkRoot), serverStoreRoot),
      serverLinkRoot,
    );

    await patchDeployedPackageVersions(packageRoot, "2026.522.0-canary.0");

    const rootPkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    const adapterPkg = JSON.parse(await readFile(path.join(adapterRoot, "package.json"), "utf8"));
    const serverPkg = JSON.parse(await readFile(path.join(serverStoreRoot, "package.json"), "utf8"));
    const sourceServerPkg = JSON.parse(await readFile(sourceServerPackageJson, "utf8"));
    assert.equal(rootPkg.version, "2026.522.0-canary.0");
    assert.equal(rootPkg.dependencies["@paperclipai/server"], "2026.522.0-canary.0");
    assert.equal(rootPkg.dependencies.picocolors, "^1.1.1");
    assert.equal(adapterPkg.version, "2026.522.0-canary.0");
    assert.equal(adapterPkg.dependencies["@paperclipai/adapter-utils"], "2026.522.0-canary.0");
    assert.equal(serverPkg.version, "2026.522.0-canary.0");
    assert.deepEqual(serverPkg.exports, {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    });
    assert.equal(serverPkg.main, "./dist/index.js");
    assert.equal(serverPkg.types, "./dist/index.d.ts");
    assert.equal(
      serverPkg.dependencies["@paperclipai/adapter-openclaw-gateway"],
      "2026.522.0-canary.0",
    );
    assert.equal(sourceServerPkg.version, "0.3.1");
    assert.equal(sourceServerPkg.exports["."], "./src/index.ts");
    assert.equal((await lstat(serverLinkRoot)).isSymbolicLink(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
