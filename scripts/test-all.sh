#!/usr/bin/env sh
set -eu
corepack pnpm typecheck
corepack pnpm test
