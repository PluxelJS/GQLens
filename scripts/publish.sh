#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Building all packages …"
turbo run build --force

pkgs=(
  packages/core
  packages/codegen
  packages/react
  packages/solid
  packages/vite
)

for pkg in "${pkgs[@]}"; do
  echo ""
  echo "==> Publishing $(basename "$pkg") …"
  npm publish --provenance --access public -w "$pkg"
done

echo ""
echo "==> All packages published."
