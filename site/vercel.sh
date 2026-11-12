#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Vercel's Node selection can follow package.json's broad supported-engine range instead of .nvmrc.
# npm exec supplies the exact existing build tools without changing package or lockfile versions.
node_version="$(tr -d '[:space:]' < .nvmrc)"
package_manager="$(node --input-type=commonjs -p 'require("./package.json").packageManager')"
case "${1:-}" in
  install) task='pnpm install --frozen-lockfile' ;;
  build) task='pnpm build && pnpm site:build' ;;
  *) echo 'Usage: bash site/vercel.sh install|build' >&2; exit 1 ;;
esac

exec npx --yes --package="node@${node_version}" --package="${package_manager}" \
  --call "node --version && pnpm --version && ${task}"
