#!/usr/bin/env bash
# Host-level devnet regression for #1567. It exercises the real edge updater
# orchestration in an isolated npm prefix/PATH: the target install reports a
# semver-prefix collision (rc.12 for expected rc.1), so verification must reject
# it and the previous rc.0 CLI must be restored.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/dkg-1567.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT INT TERM
mkdir -p "$tmp/bin" "$tmp/home"
version_file="$tmp/version"
printf '%s\n' '10.0.0-rc.0' >"$version_file"

printf '%s\n' '#!/bin/sh' \
  'case "$*" in' \
  '  *10.0.0-rc.1*) printf "%s\n" "10.0.0-rc.12" >"$FAKE_DKG_VERSION_FILE" ;;' \
  '  *10.0.0-rc.0*) printf "%s\n" "10.0.0-rc.0" >"$FAKE_DKG_VERSION_FILE" ;;' \
  '  *) exit 2 ;;' \
  'esac' >"$tmp/bin/npm"
printf '%s\n' '#!/bin/sh' \
  'printf "%s\n" "dkg 10.0.0-rc.1"' >"$tmp/bin/dkg"
printf '%s\n' \
  'import { readFileSync } from "node:fs";' \
  'const version = readFileSync(process.env.FAKE_DKG_VERSION_FILE, "utf8").trim();' \
  'process.stdout.write(`dkg ${version}\n`);' >"$tmp/restart-entry.mjs"
chmod +x "$tmp/bin/npm" "$tmp/bin/dkg"

result="$(
  PATH="$tmp/bin:$PATH" DKG_HOME="$tmp/home" FAKE_DKG_VERSION_FILE="$version_file" \
  FAKE_DKG_RESTART_ENTRY="$tmp/restart-entry.mjs" \
  node --input-type=module <<'NODE'
import { performNpmUpdateEdge } from './packages/cli/dist/daemon/auto-update.js';
const restartCommand = {
  nodeExecutable: process.execPath,
  nodeExecArgv: [],
  restartEntryPoint: process.env.FAKE_DKG_RESTART_ENTRY,
};
const logs = [];
const result = await performNpmUpdateEdge(
  '10.0.0-rc.1',
  '10.0.0-rc.0',
  (line) => logs.push(line),
  restartCommand,
);
process.stdout.write(JSON.stringify({ result, logs }));
NODE
)"

RESULT="$result" node -e '
const value = JSON.parse(process.env.RESULT);
if (value.result !== "failed") throw new Error(`expected failed-with-rollback, got ${value.result}`);
if (!value.logs.some((line) => line.includes("expected 10.0.0-rc.1"))) throw new Error("exact mismatch was not detected");
if (!value.logs.some((line) => line.includes("rollback restored"))) throw new Error("rollback was not verified");
'
[[ "$(cat "$version_file")" == 10.0.0-rc.0 ]] || { echo "[#1567] FAIL: previous CLI not restored" >&2; exit 1; }
[[ "$(cat "$tmp/home/previous-version")" == 10.0.0-rc.0 ]] || { echo "[#1567] FAIL: rollback target not recorded" >&2; exit 1; }
echo "[#1567] PASS: exact-version self-check rejected rc.12 and restored rc.0"
