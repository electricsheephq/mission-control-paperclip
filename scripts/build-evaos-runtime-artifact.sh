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
SKILL_PACKAGE_DIRS=(
  "server"
  "packages/adapters/claude-local"
  "packages/adapters/codex-local"
)

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

SOURCE_SHA="$(git -C "$REPO_ROOT" rev-parse "$SOURCE_REF^{commit}")"
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if [[ "$SOURCE_SHA" != "$HEAD_SHA" ]]; then
  echo "ERROR: source ref does not match the checked-out commit" >&2
  exit 1
fi
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)" ]]; then
  echo "ERROR: refusing to build an evaOS runtime artifact from a dirty checkout" >&2
  exit 1
fi

OUT_DIR="$(node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  let candidate = path.resolve(process.argv[1]);
  const suffix = [];
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    suffix.unshift(path.basename(candidate));
    candidate = parent;
  }
  process.stdout.write(path.join(fs.realpathSync(candidate), ...suffix));
' "$OUT_DIR")"
case "$OUT_DIR/" in
  "$REPO_ROOT/server/ui-dist/"*)
    echo "ERROR: output directory must not be server/ui-dist or a descendant" >&2
    exit 1
    ;;
esac
mkdir -p "$OUT_DIR"
ARTIFACT_NAME="$(node "$REPO_ROOT/scripts/evaos-runtime-artifact.mjs" artifact-name --version "$VERSION" --out-dir "$OUT_DIR" --source-ref "$SOURCE_REF")"
ARTIFACT_PATH="$OUT_DIR/$ARTIFACT_NAME"
SHA_PATH="$ARTIFACT_PATH.sha256"
MANIFEST_PATH="$OUT_DIR/manifest.json"
STAGE_PARENT="$(mktemp -d "$OUT_DIR/.paperclip-evaos-runtime.XXXXXX")"
PACKAGE_ROOT="$STAGE_PARENT/paperclipai"
SKILLS_BACKUP_ROOT="$STAGE_PARENT/original-skills"

restore_skill_dirs() {
  local pkg_dir
  for pkg_dir in "${SKILL_PACKAGE_DIRS[@]}"; do
    if [[ ! -f "$SKILLS_BACKUP_ROOT/$pkg_dir/.skills-replaced" ]]; then
      continue
    fi
    rm -rf "$REPO_ROOT/$pkg_dir/skills"
    if [[ -f "$SKILLS_BACKUP_ROOT/$pkg_dir/.skills-existed" ]]; then
      cp -a "$SKILLS_BACKUP_ROOT/$pkg_dir/skills" "$REPO_ROOT/$pkg_dir/skills"
    fi
  done
}

cleanup() {
  if [[ "$BUILD_EXECUTED" == "1" ]]; then
    restore_skill_dirs
    rm -rf "$REPO_ROOT/server/ui-dist"
    if [[ -f "$SKILLS_BACKUP_ROOT/server/.ui-dist-existed" ]]; then
      cp -a "$SKILLS_BACKUP_ROOT/server/ui-dist" "$REPO_ROOT/server/ui-dist"
    fi
  fi

  if [[ "$KEEP_STAGE" != "1" ]]; then
    rm -rf "$STAGE_PARENT"
  else
    printf 'kept artifact stage at %s\n' "$STAGE_PARENT"
  fi
}
trap cleanup EXIT

cd "$REPO_ROOT"

if [[ "$SKIP_BUILD" != "1" ]]; then
  pnpm run preflight:workspace-links
  pnpm build
  node "$REPO_ROOT/scripts/build-standalone-public-packages.mjs"
fi

BUILD_EXECUTED=1
mkdir -p "$SKILLS_BACKUP_ROOT/server"
if [[ -e "$REPO_ROOT/server/ui-dist" || -L "$REPO_ROOT/server/ui-dist" ]]; then
  cp -a "$REPO_ROOT/server/ui-dist" "$SKILLS_BACKUP_ROOT/server/ui-dist"
  touch "$SKILLS_BACKUP_ROOT/server/.ui-dist-existed"
fi
bash "$REPO_ROOT/scripts/prepare-server-ui-dist.sh"
for pkg_dir in "${SKILL_PACKAGE_DIRS[@]}"; do
  mkdir -p "$SKILLS_BACKUP_ROOT/$pkg_dir"
  if [[ -e "$REPO_ROOT/$pkg_dir/skills" || -L "$REPO_ROOT/$pkg_dir/skills" ]]; then
    cp -a "$REPO_ROOT/$pkg_dir/skills" "$SKILLS_BACKUP_ROOT/$pkg_dir/skills"
    touch "$SKILLS_BACKUP_ROOT/$pkg_dir/.skills-existed"
  fi
  touch "$SKILLS_BACKUP_ROOT/$pkg_dir/.skills-replaced"
  rm -rf "$REPO_ROOT/$pkg_dir/skills"
  cp -R "$REPO_ROOT/skills" "$REPO_ROOT/$pkg_dir/skills"
done

rm -rf "$PACKAGE_ROOT"
pnpm --filter paperclipai deploy --prod "$PACKAGE_ROOT"
cp -R "$REPO_ROOT/skills" "$PACKAGE_ROOT/skills"
node "$REPO_ROOT/scripts/evaos-runtime-artifact.mjs" patch-versions "$PACKAGE_ROOT" "$VERSION"
CLI_RUNTIME_EXTERNALS_RAW="$(node --input-type=module <<'NODE'
import config from "./cli/esbuild.config.mjs";
const embeddedPostgresTarget = "@embedded-postgres/linux-x64";
for (const external of config.external ?? []) {
  if (external.startsWith("@embedded-postgres/") && external !== embeddedPostgresTarget) {
    continue;
  }
  console.log(external);
}
NODE
)"
CLI_RUNTIME_EXTERNALS=()
while IFS= read -r external; do
  [[ -n "$external" ]] && CLI_RUNTIME_EXTERNALS+=("$external")
done <<<"$CLI_RUNTIME_EXTERNALS_RAW"
if ((${#CLI_RUNTIME_EXTERNALS[@]} == 0)); then
  echo "ERROR: no Linux x64 CLI runtime externals resolved from cli/esbuild.config.mjs" >&2
  exit 1
fi
node "$REPO_ROOT/scripts/evaos-runtime-artifact.mjs" link-cli-externals "$PACKAGE_ROOT" "${CLI_RUNTIME_EXTERNALS[@]}"
node "$REPO_ROOT/scripts/evaos-runtime-artifact.mjs" hydrate-embedded-postgres-native "$PACKAGE_ROOT" >/dev/null

if [[ "$SKIP_SMOKE" != "1" ]]; then
  node "$PACKAGE_ROOT/dist/index.js" --version >/dev/null
  node "$PACKAGE_ROOT/dist/index.js" run --help >/dev/null
  (cd "$PACKAGE_ROOT" && node --input-type=module -e 'await import("@paperclipai/server")')
  (cd "$PACKAGE_ROOT" && node --input-type=module -e 'await import("@paperclipai/hermes-paperclip-adapter")')
  grep -R "PAPERCLIP_RECONCILE_BUILT_IN_AGENTS_ON_STARTUP" "$PACKAGE_ROOT/node_modules/@paperclipai/server/dist" >/dev/null
fi

rm -f "$ARTIFACT_PATH" "$SHA_PATH" "$MANIFEST_PATH"
tar --owner=0 --group=0 --numeric-owner -C "$STAGE_PARENT" -czf "$ARTIFACT_PATH" paperclipai
SHA256="$(node "$REPO_ROOT/scripts/evaos-runtime-artifact.mjs" sha256 "$ARTIFACT_PATH")"
printf '%s  %s\n' "$SHA256" "$ARTIFACT_NAME" >"$SHA_PATH"
node "$REPO_ROOT/scripts/evaos-runtime-artifact.mjs" write-manifest \
  "$MANIFEST_PATH" "$VERSION" "$SOURCE_REF" "$SOURCE_SHA" "$ARTIFACT_NAME" "$SHA256"

printf 'artifact=%s\nsha256=%s\nmanifest=%s\n' "$ARTIFACT_PATH" "$SHA_PATH" "$MANIFEST_PATH"
