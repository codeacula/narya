#!/usr/bin/env bash
# Emit a .d.ts tree for the design-sync converter.
#
# This repo is an app, not a published library: tsconfig.json sets noEmit and
# there is no dist/. The converter's prop extractor reads ONLY a .d.ts tree
# (lib/dts.mjs) and falls back to a component's call signature via the types
# entry, so without this step every <Name>Props comes out as
# `[key: string]: unknown` and the design agent gets no API contract.
#
# Output: build/ts/**/*.d.ts (gitignored) + a generated build/ts/index.d.ts
# barrel. package.json "types" points at that barrel, which is what makes
# findTypesRoot() resolve to build/ts and getSourceFile(entry) succeed.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf build/ts
npx tsc -p .design-sync/tsconfig.types.json

# The barrel is generated here rather than committed into src/ so the app's
# source stays free of sync-only scaffolding.
{
  for f in client/ui/icons client/ui/authGate client/ui/notifications \
           client/ui/serviceStatus client/ui/shell client/ui/tweaks client/ui/panels; do
    echo "export * from './${f}';"
  done
} > build/ts/index.d.ts

echo "build-types: $(find build/ts -name '*.d.ts' | wc -l) declaration files"
