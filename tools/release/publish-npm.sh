#!/usr/bin/env bash
# Publish @insiderfinance/totalfinance to npm from your own machine, from a clean, up-to-date main:
# a clean build, the pack and its checks (release:dry-run), then `npm publish` of that tarball.
# This is how 0.1.1 and 0.1.2 were published; the hosted release workflow is not set up.
#
#   tools/release/publish-npm.sh             publish the version in distribution/totalfinance
#   tools/release/publish-npm.sh --dry-run   build, pack and check; publish nothing
#
# The version comes from the release commit (changeset version + publication:update). The optional
# MCP package is packed but not published.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail() {
  echo "publish-npm: $*" >&2
  exit 1
}

dry_run=false
case "${1:-}" in
  '') ;;
  --dry-run) dry_run=true ;;
  *) fail "unknown argument '$1' (use --dry-run or nothing)" ;;
esac

name=@insiderfinance/totalfinance
version=$(node -p "require('./distribution/totalfinance/package.json').version")
# The ./ matters: without it npm reads the path as a GitHub shorthand.
tarball="./release/insiderfinance-totalfinance-${version}.tgz"

[[ -z "$(git status --porcelain)" ]] ||
  fail "the working tree is not clean; commit or 'git stash -u' first:
$(git status --short)"
git fetch --quiet origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] ||
  fail "HEAD is not origin/main; run 'git checkout main && git pull --ff-only' first"
if npm view "${name}@${version}" version >/dev/null 2>&1; then
  fail "${name}@${version} is already on npm; release a new version first"
fi

echo "publish-npm: ${name}@${version} from $(git rev-parse --short HEAD)"
pnpm install --frozen-lockfile
# Stale build output fails the pack's source-map and entry-point checks; the pack refuses an
# existing release/ directory.
rm -rf release packages/*/dist distribution/*/modules
find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete
pnpm build
pnpm release:dry-run --skip-ci --expect-version "$version"

if $dry_run; then
  echo "publish-npm: packed and checked ${tarball}; --dry-run, nothing published"
  exit 0
fi
# No provenance: provenance needs a CI identity, and this publish runs on your machine.
npm publish "$tarball" --provenance=false
echo "publish-npm: npm now has ${name}@$(npm view "${name}@${version}" version)"
