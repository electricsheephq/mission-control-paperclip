import assert from "node:assert/strict";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
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
  hydrateEmbeddedPostgresNativeSymlinks,
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
      "--skip-smoke",
    ]),
    {
      help: false,
      version: "2026.522.0-canary.0",
      outDir: "/tmp/evaos",
      sourceRef: "5e99b8c1",
      skipSmoke: true,
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

test("build script targets Linux x64 externals, restores source skills, and normalizes tar ownership", async () => {
  const script = await readFile(new URL("./build-evaos-runtime-artifact.sh", import.meta.url), "utf8");
  assert.match(script, /hydrate-embedded-postgres-native "\$PACKAGE_ROOT"/);
  assert.match(script, /embeddedPostgresTarget = "@embedded-postgres\/linux-x64"/);
  assert.match(script, /restore_skill_dirs/);
  assert.match(script, /no Linux x64 CLI runtime externals resolved/);
  assert.match(script, /tar --owner=0 --group=0 --numeric-owner/);
  assert.match(script, /source ref does not match the checked-out commit/);
  assert.match(script, /refusing to build an evaOS runtime artifact from a dirty checkout/);
  assert.match(script, /fs\.realpathSync\(candidate\)/);
  assert.match(script, /output directory must be outside the source repository/);
  assert.ok(
    script.indexOf("output directory must be outside the source repository")
      < script.indexOf('mkdir -p "$OUT_DIR"'),
  );
  assert.match(script, /cp -R "\$REPO_ROOT\/skills" "\$PACKAGE_ROOT\/skills"/);
  assert.match(script, /pnpm -r --if-present clean/);
  assert.match(script, /prepare-server-ui-dist\.sh/);
  assert.doesNotMatch(script, /--skip-build|SKIP_BUILD/);
});

test("release publication is restricted to the default branch", async () => {
  const workflow = await readFile(new URL("../.github/workflows/evaos-runtime-release.yml", import.meta.url), "utf8");
  assert.match(workflow, /EVAOS_RELEASE_REF: \$\{\{ github\.ref \}\}/);
  assert.match(workflow, /EVAOS_RELEASE_REF" != "refs\/heads\/master"/);
  assert.match(workflow, /runner\.temp }}\/evaos-artifacts/);
  assert.match(workflow, /git\/ref\/tags\/\$\{encoded_tag}/);
  assert.match(workflow, /test "\$existing_sha" = "\$EVAOS_ARTIFACT_SOURCE_SHA"/);
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

test("linkCliRuntimeExternals fails descriptively when the deployed pnpm tree is absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-evaos-links-missing-"));
  const packageRoot = path.join(root, "paperclipai");
  try {
    await mkdir(path.join(packageRoot, "node_modules"), { recursive: true });
    await assert.rejects(
      linkCliRuntimeExternals(packageRoot, ["missing-runtime"]),
      /deployed dependency not found for CLI external: missing-runtime/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("linkCliRuntimeExternals rejects ambiguous deployed dependency versions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-evaos-links-ambiguous-"));
  const packageRoot = path.join(root, "paperclipai");
  try {
    for (const version of ["1.0.0", "2.0.0"]) {
      await mkdir(
        path.join(packageRoot, "node_modules", ".pnpm", `runtime@${version}`, "node_modules", "runtime"),
        { recursive: true },
      );
    }
    await assert.rejects(
      linkCliRuntimeExternals(packageRoot, ["runtime"]),
      /ambiguous deployed dependency for CLI external runtime/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("linkCliRuntimeExternals deduplicates pnpm aliases to one physical package", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-evaos-links-aliases-"));
  const packageRoot = path.join(root, "paperclipai");
  const target = path.join(packageRoot, "node_modules", ".pnpm", "runtime-target");
  try {
    await mkdir(target, { recursive: true });
    for (const name of ["runtime@1.0.0", "runtime@alias"]) {
      const parent = path.join(packageRoot, "node_modules", ".pnpm", name, "node_modules");
      await mkdir(parent, { recursive: true });
      await symlink(target, path.join(parent, "runtime"));
    }
    assert.deepEqual(await linkCliRuntimeExternals(packageRoot, ["runtime"]), ["runtime"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("linkCliRuntimeExternals prefers the version reachable from a direct dependency", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-evaos-links-direct-dependency-"));
  const packageRoot = path.join(root, "paperclipai");
  const sharedStoreRoot = path.join(
    packageRoot,
    "node_modules",
    ".pnpm",
    "@paperclipai+shared@file+packages+shared",
    "node_modules",
  );
  const sharedRoot = path.join(sharedStoreRoot, "@paperclipai", "shared");
  const unrelated = path.join(packageRoot, "node_modules", ".pnpm", "zod@3", "node_modules", "zod");
  const expected = path.join(packageRoot, "node_modules", ".pnpm", "zod@4.4.3", "node_modules", "zod");
  try {
    await mkdir(sharedRoot, { recursive: true });
    await mkdir(expected, { recursive: true });
    await mkdir(unrelated, { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ dependencies: { "@paperclipai/shared": "workspace:*" } }));
    await writeFile(path.join(sharedRoot, "package.json"), JSON.stringify({ name: "@paperclipai/shared", dependencies: { zod: "^4.4.3" } }));
    await symlink(expected, path.join(sharedStoreRoot, "zod"));
    await mkdir(path.join(packageRoot, "node_modules", "@paperclipai"), { recursive: true });
    await symlink(sharedRoot, path.join(packageRoot, "node_modules", "@paperclipai", "shared"));
    await symlink(unrelated, path.join(packageRoot, "node_modules", "zod"));
    await writeFile(path.join(expected, "package.json"), JSON.stringify({ name: "zod", version: "4.4.3" }));

    assert.deepEqual(await linkCliRuntimeExternals(packageRoot, ["zod"]), ["zod"]);
    assert.equal(
      await realpath(path.join(packageRoot, "node_modules", "zod")),
      await realpath(expected),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("linkCliRuntimeExternals rejects declared dependencies outside the artifact tree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-evaos-links-outside-"));
  const packageRoot = path.join(root, "paperclipai");
  const sharedStoreRoot = path.join(packageRoot, "node_modules", ".pnpm", "shared", "node_modules");
  const sharedRoot = path.join(sharedStoreRoot, "@paperclipai", "shared");
  const outside = path.join(root, "outside-runtime");
  try {
    await mkdir(sharedRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), "{}");
    await writeFile(path.join(sharedRoot, "package.json"), JSON.stringify({ dependencies: { runtime: "1" } }));
    await writeFile(path.join(outside, "package.json"), JSON.stringify({ name: "runtime" }));
    await symlink(outside, path.join(sharedStoreRoot, "runtime"));
    await mkdir(path.join(packageRoot, "node_modules", "@paperclipai"), { recursive: true });
    await symlink(sharedRoot, path.join(packageRoot, "node_modules", "@paperclipai", "shared"));
    await assert.rejects(linkCliRuntimeExternals(packageRoot, ["runtime"]), /outside artifact tree/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("linkCliRuntimeExternals rejects a direct dependency outside the artifact tree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-evaos-links-direct-outside-"));
  const packageRoot = path.join(root, "paperclipai");
  const outside = path.join(root, "outside-runtime");
  try {
    await mkdir(path.join(packageRoot, "node_modules"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(packageRoot, "node_modules", "runtime"));
    await assert.rejects(linkCliRuntimeExternals(packageRoot, ["runtime"]), /outside artifact tree/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("linkCliRuntimeExternals rejects a pnpm dependency outside the artifact tree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-evaos-links-pnpm-outside-"));
  const packageRoot = path.join(root, "paperclipai");
  const candidateParent = path.join(packageRoot, "node_modules", ".pnpm", "runtime@1", "node_modules");
  const outside = path.join(root, "outside-runtime");
  try {
    await mkdir(candidateParent, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(candidateParent, "runtime"));
    await assert.rejects(linkCliRuntimeExternals(packageRoot, ["runtime"]), /outside artifact tree/);
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

test("hydrateEmbeddedPostgresNativeSymlinks prepares native links for service-user startup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-evaos-embedded-postgres-"));
  const packageRoot = path.join(root, "paperclipai");
  const postgresRoot = path.join(
    packageRoot,
    "node_modules",
    "@embedded-postgres",
    "linux-x64",
  );
  const nativeLibRoot = path.join(postgresRoot, "native", "lib");

  try {
    await mkdir(nativeLibRoot, { recursive: true });
    await writeFile(path.join(nativeLibRoot, "libpq.so.5.18"), "libpq");
    await writeFile(path.join(nativeLibRoot, "libcrypto.so.1.1"), "crypto");
    await writeFile(path.join(nativeLibRoot, "libssl.so.1.1"), "ssl");
    await writeFile(path.join(postgresRoot, "native", "pg-symlinks.json"), JSON.stringify([
      {
        source: "native/lib/libpq.so.5.18",
        target: "native/lib/libpq.so.5",
      },
    ]));

    const result = await hydrateEmbeddedPostgresNativeSymlinks(packageRoot);

    assert.equal(result.packageRoot, postgresRoot);
    assert.deepEqual(result.manifestSymlinks, ["native/lib/libpq.so.5"]);
    assert.deepEqual(result.nativeAliases, [
      "native/lib/libcrypto.so.1",
      "native/lib/libssl.so.1",
    ]);
    assert.equal(await readlink(path.join(nativeLibRoot, "libpq.so.5")), "libpq.so.5.18");
    assert.equal(await readlink(path.join(nativeLibRoot, "libcrypto.so.1")), "libcrypto.so.1.1");
    assert.equal(await readlink(path.join(nativeLibRoot, "libssl.so.1")), "libssl.so.1.1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
