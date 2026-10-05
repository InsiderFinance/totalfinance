#!/usr/bin/env bash
# Release TotalFinance in one command, from a clean, up-to-date main with pending changesets:
# version the public pair from the changesets, regenerate what carries the version, commit
# "Release <version>", push main, then publish to npm (tools/release/publish-npm.sh).
#
#   tools/release/release.sh               the bump the changesets ask for (patch, minor, …)
#   tools/release/release.sh --patch       release every pending change as a patch (0.1.2 → 0.1.3)
#   tools/release/release.sh --minor       … as a minor (0.1.2 → 0.2.0)
#   tools/release/release.sh --no-publish  stop after pushing the release commit
#   tools/release/release.sh --dry-run     version and regenerate here; no commit, push or publish
#
# Hosted CI runs the full suites on the pushed commit; this script runs only the checks a version
# change can break. npm may ask for your one-time password at the end.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail() {
  echo "release: $*" >&2
  exit 1
}
step() { echo "release: $*"; }

bump=''
publish=true
dry_run=false
for arg in "$@"; do
  case "$arg" in
    --patch | --minor | --major) bump="${arg#--}" ;;
    --no-publish) publish=false ;;
    --dry-run) dry_run=true ;;
    *) fail "unknown argument '$arg'" ;;
  esac
done

version() { node -p "require('./distribution/totalfinance/package.json').version"; }
pending=$(find .changeset -maxdepth 1 -name '*.md' ! -name 'README.md' ! -name '.*' | sort)

[[ -z "$(git status --porcelain)" ]] ||
  fail "the working tree is not clean; commit or 'git stash -u' first:
$(git status --short)"
git fetch --quiet origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] ||
  fail "HEAD is not origin/main; run 'git checkout main && git pull --ff-only' first"
[[ -n "$pending" ]] || fail "no pending changesets in .changeset/; nothing to release"

from=$(version)
pnpm install --frozen-lockfile >/dev/null

if [[ -n "$bump" ]]; then
  step "releasing every pending change as a $bump"
  for file in $pending; do
    sed -i.bak -E "s/^('@insiderfinance\/[a-z-]+'): (patch|minor|major)$/\1: $bump/" "$file"
    rm -f "$file.bak"
  done
fi

step "versioning from $from"
pnpm exec changeset version
pnpm publication:update
pnpm install --no-frozen-lockfile >/dev/null
# publication:update rewrites tsconfig.json in its own style; keep the repository's.
./node_modules/.bin/prettier --write tsconfig.json >/dev/null
to=$(version)
[[ "$to" != "$from" ]] || fail "changeset version left the version at $from"
step "version $from → $to"

# Hand-written statements of the current release.
for file in README.md SECURITY.md STABILITY.md; do
  sed -i.bak "s/${from//./\\.}/$to/g" "$file"
  rm -f "$file.bak"
done

step "building and regenerating what carries the version"
# The naming inventory and API reports read built declarations.
pnpm build >/dev/null
pnpm naming:update >/dev/null
pnpm api:update >/dev/null
pnpm exec tsx tools/readme-gen.ts >/dev/null
pnpm exec tsx tools/llms-docs.ts >/dev/null
pnpm openapi:update >/dev/null

stale=$(git grep -l -F "$from" -- README.md SECURITY.md STABILITY.md 'packages/*/README.md' \
  docs/llms.txt docs/llms-full.txt 'packages/*/etc/*' tools/manifest/public-naming.json \
  packages/workflows/src/version.ts || true)
[[ -z "$stale" ]] || fail "these still name $from after regeneration:
$stale"

step "checking the release pins"
pnpm exec vitest run tools/preview-surface-audit.test.ts tools/public-reference.test.ts \
  tools/assemble-distribution.test.ts >/dev/null ||
  fail "the release-pin checks failed; run them without >/dev/null to see why"

if $dry_run; then
  step "--dry-run: $to is versioned in this tree, not committed; 'git status' shows it"
  exit 0
fi

git add -A
git commit --quiet --file=- <<EOF
Release $to

changeset version and publication:update for the public pair (@insiderfinance/totalfinance and
@insiderfinance/totalfinance-mcp), $from → $to. The release notes are in
distribution/totalfinance/CHANGELOG.md. README, SECURITY, STABILITY, package READMEs, llms docs,
the OpenAPI version, the API reports and the naming manifest name $to.

Made with tools/release/release.sh.
EOF
git push --quiet origin HEAD:main
step "pushed $(git rev-parse --short HEAD) to main"

if $publish; then
  exec ./tools/release/publish-npm.sh
fi
step "not published; run tools/release/publish-npm.sh when ready"
