#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=""
OUT_DIR=""
SOURCE_REF="HEAD"
SKIP_BUILD=0
SKIP_SMOKE=0
KEEP_STAGE=0
BUILD_EXECUTED=0

usage() {
  cat <<'USAGE'
Usage: scripts/build-evaos-runtime-artifact.sh --version VERSION --out-dir DIR [options]

Builds the internal evaOS/RVM Paperclip runtime artifact from this fork without
publishing paperclipai or @paperclipai/* packages to npm.

Options:
  --version VERSION    Artifact/runtime version to stamp into the deployed tree.
  --out-dir DIR        Output directory for tarball, sha256, and manifest.
  --source-ref REF     Source ref recorded in the manifest (default: HEAD).
  --skip-build         Reuse existing build outputs before pnpm deploy.
  --skip-smoke         Do not run local artifact command/grep smoke checks.
  --keep-stage         Keep the temporary deploy stage for inspection.
  -h, --help           Show this help.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="${2:?missing version}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:?missing output directory}"; shift 2 ;;
    --source-ref) SOURCE_REF="${2:?missing source ref}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-smoke) SKIP_SMOKE=1; shift ;;
    --keep-stage) KEEP_STAGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

node "$REPO_ROOT/scripts/evaos-runtime-artifact.mjs" artifact-name \
  --version "${VERSION}" --out-dir "${OUT_DIR}" --source-ref "${SOURCE_REF}" >/dev/null

command -v pnpm >/dev/null 2>&1 || { echo "ERROR: pnpm is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: node is required" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "ERROR: tar is required" >&2; exit 1; }

mkdir -p "$OUT_DIR"
ARTIFACT_NAME="$(node "$REPO_ROOT/scripts/evaos-runtime-artifact.mjs" artifact-name --version "$VERSION" --out-dir "$OUT_DIR" --source-ref "$SOURCE_REF")"
ARTIFACT_PATH="$OUT_DIR/$ARTIFACT_NAME"
SHA_PATH="$ARTIFACT_PATH.sha256"
MANIFEST_PATH="$OUT_DIR/manifest.json"
STAGE_PARENT="$(mktemp -d "$OUT_DIR/.paperclip-evaos-runtime.XXXXXX")"
PACKAGE_ROOT="$STAGE_PARENT/paperclipai"

cleanup() {
  if [[ "$KEEP_STAGE" != "1" ]]; then
    rm -rf "$STAGE_PARENT"
  else
    printf 'kept artifact stage at %s\n' "$STAGE_PARENT"
  fi

  if [[ "$BUILD_EXECUTED" == "1" ]]; then
    rm -rf "$REPO_ROOT/server/ui-dist"
    for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
      rm -rf "$REPO_ROOT/$pkg_dir/skills"
    done
  fi
}
trap cleanup EXIT

cd "$REPO_ROOT"

if [[ "$SKIP_BUILD" != "1" ]]; then
  BUILD_EXECUTED=1
  pnpm run preflight:workspace-links
  pnpm build
  node "$REPO_ROOT/scripts/build-standalone-public-packages.mjs"
  bash "$REPO_ROOT/scripts/prepare-server-ui-dist.sh"
  for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
    rm -rf "$REPO_ROOT/$pkg_dir/skills"
    cp -R "$REPO_ROOT/skills" "$REPO_ROOT/$pkg_dir/skills"
  done
fi

rm -rf "$PACKAGE_ROOT"
pnpm --filter paperclipai deploy --prod "$PACKAGE_ROOT"
node "$REPO_ROOT/scripts/evaos-runtime-artifact.mjs" patch-versions "$PACKAGE_ROOT" "$VERSION"
mapfile -t CLI_RUNTIME_EXTERNALS < <(node --input-type=module <<'NODE'
import config from "./cli/esbuild.config.mjs";
for (const external of config.external ?? []) {
  console.log(external);
}
NODE
)
if ((${#CLI_RUNTIME_EXTERNALS[@]} > 0)); then
  node "$REPO_ROOT/scripts/evaos-runtime-artifact.mjs" link-cli-externals "$PACKAGE_ROOT" "${CLI_RUNTIME_EXTERNALS[@]}"
fi

if [[ "$SKIP_SMOKE" != "1" ]]; then
  node "$PACKAGE_ROOT/dist/index.js" --version >/dev/null
  node "$PACKAGE_ROOT/dist/index.js" run --help >/dev/null
  grep -R "PAPERCLIP_OPENCLAW_PROVISIONER" "$PACKAGE_ROOT/node_modules/@paperclipai/server/dist" >/dev/null
  grep -R "gatewayMaxConcurrentRuns" "$PACKAGE_ROOT/node_modules/@paperclipai/server/dist" >/dev/null
fi

rm -f "$ARTIFACT_PATH" "$SHA_PATH" "$MANIFEST_PATH"
tar -C "$STAGE_PARENT" -czf "$ARTIFACT_PATH" paperclipai
SHA256="$(node "$REPO_ROOT/scripts/evaos-runtime-artifact.mjs" sha256 "$ARTIFACT_PATH")"
printf '%s  %s\n' "$SHA256" "$ARTIFACT_NAME" >"$SHA_PATH"
SOURCE_SHA="$(git -C "$REPO_ROOT" rev-parse "$SOURCE_REF^{commit}")"
node "$REPO_ROOT/scripts/evaos-runtime-artifact.mjs" write-manifest \
  "$MANIFEST_PATH" "$VERSION" "$SOURCE_REF" "$SOURCE_SHA" "$ARTIFACT_NAME" "$SHA256"

printf 'artifact=%s\nsha256=%s\nmanifest=%s\n' "$ARTIFACT_PATH" "$SHA_PATH" "$MANIFEST_PATH"
