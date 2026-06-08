#!/usr/bin/env bash
set -euo pipefail

repo="PluxelJS/GQLens"
file=".github/workflows/release.yml"

packages=(
  "@gqlens/core"
  "@gqlens/codegen"
  "@gqlens/react"
  "@gqlens/solid"
  "@gqlens/vite"
)

echo "Trusting GitHub Actions OIDC publisher for ${repo} …"
echo ""

for pkg in "${packages[@]}"; do
  echo "  ── ${pkg}"
  npm trust github "$pkg" \
    --repo "$repo" \
    --file "$file" \
    --allow-publish \
    --yes 2>/dev/null || echo "      (skipped — may need manual setup on npmjs.com)"
  sleep 1
done

echo ""
echo "Done. Verify at https://www.npmjs.com/settings/${packages[0]}/trusted-publishers"
