#!/usr/bin/env bash
#
# #1229 / OT-RFC-53 — context-graph registration DEPOSIT: devnet proof.
#
# Closes the rc19 coverage gap: the deposit lifecycle had strong unit/hardhat
# coverage but NO multi-node devnet test with the param LIVE (the devnet ships
# the deposit dormant: ParametersStorage constructor = 0 AND deploy/054 returns
# early on chainId 31337). This arms it on the running devnet chain and proves:
#
#   1. DORMANT by default: a CG registered with param==0 escrows nothing.
#   2. ARMED: with the param set live, registering a CG pulls the deposit GROSS
#      into the CSS vault — getRegistrationEscrow(cgId) == deposit, and the
#      client adapter's lazy approve-and-retry funds the allowance with no
#      manual approve.
#   3. Param is RESET to 0 at teardown (dormant-regression-safe for other suites).
#
# Governance setter is called with the local Hardhat deployer (Hub owner) key —
# this is the PUBLIC well-known hardhat account[0] key, valid only on the local
# 31337 devnet chain. It is NOT a real deployer key.
#
# Requires a running devnet (./scripts/devnet.sh start 6). Self-contained.
#
# Standalone MANUAL proof — run directly; intentionally NOT wired into
# devnet-comprehensive.sh / _devnet-full-sweep.sh. This one arms a GLOBAL chain
# param (and restores it via trap), so it is deliberately kept out of the shared
# orchestrated run; see PR #1244.
#   Run:  ./scripts/devnet-test-cg-registration-deposit.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
NODE_DIR="$DEVNET_DIR/node1"
CLI_JS="$REPO_ROOT/packages/cli/dist/cli.js"
CHAIN_CALL="$REPO_ROOT/scripts/devnet-chain-call.mjs"
STAMP="$(node -e 'process.stdout.write(String(Date.now()))')"

# Local hardhat account[0] (deployer / Hub owner). PUBLIC test key, devnet-only.
GOV_KEY="${GOV_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
DEPOSIT="${DEPOSIT:-1000000000000000000}"   # 1 TRAC (small, affordable by the op-wallet)

PASS=0; FAIL=0
log() { echo "[cg-deposit] $*"; }
ok()  { echo "[cg-deposit]   PASS: $*"; PASS=$((PASS+1)); }
bad() { echo "[cg-deposit]   FAIL: $*" >&2; FAIL=$((FAIL+1)); }
act() { echo; echo "[cg-deposit] === $* ==="; }

call() { node "$CHAIN_CALL" "$@" 2>&1; }
# shared field() (+ node auth / HTTP helpers, unused here) from the devnet lib
. "$REPO_ROOT/scripts/devnet-lib.sh" || { echo "[cg-deposit] FATAL: cannot source devnet-lib.sh" >&2; exit 2; }

# create + on-chain register a CG via the node's daemon; echoes the numeric on-chain id
create_register_cg() {
  local slug="$1" out fq onchain
  out=$(DKG_HOME="$NODE_DIR" node "$CLI_JS" context-graph create "$slug" --name "deposit-$slug" 2>&1) || { echo "CREATE_FAIL: $out" >&2; return 1; }
  fq=$(printf '%s' "$out" | grep -oE 'did:dkg:context-graph:[^ "]+' | head -1)
  [ -z "$fq" ] && fq="$slug"
  out=$(DKG_HOME="$NODE_DIR" node "$CLI_JS" context-graph register "$fq" 2>&1) || { echo "REGISTER_FAIL: $out" >&2; return 1; }
  onchain=$(printf '%s' "$out" | grep -oiE 'on-?chain[^0-9]*[0-9]+|contextGraphId[^0-9]*[0-9]+|id[^0-9]*[0-9]+' | grep -oE '[0-9]+' | tail -1)
  printf '%s' "$onchain"
}

[ -f "$CLI_JS" ] || { echo "[cg-deposit] FATAL: CLI not built ($CLI_JS)"; exit 2; }

# ============================================================================
act "0. baseline — deposit param is DORMANT (0) on the devnet"
# ============================================================================
P0=$(field "$(call ParametersStorage contextGraphRegistrationDeposit)" result)
[ "$P0" = "0" ] && ok "deposit param dormant at baseline (0)" || bad "expected param 0 at baseline, got '$P0'"

# Restore the baseline deposit on ANY exit path (crash, timeout, Ctrl-C) so an
# interrupted run can't leave the GLOBAL param live for later suites. Armed only
# after we actually set it; disarmed once the verified teardown has reset it, so
# on the happy path the EXIT trap is a no-op. Restores the captured baseline P0
# (asserted 0 above), not a hard-coded 0.
DEPOSIT_ARMED=0
cleanup() {
  [ "$DEPOSIT_ARMED" = "1" ] || return 0
  echo "[cg-deposit] cleanup: restoring deposit param to baseline ($P0)" >&2
  call ParametersStorage setContextGraphRegistrationDeposit --key "$GOV_KEY" --json "[\"$P0\"]" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# ============================================================================
act "1. DORMANT path — register a CG, escrow must be 0"
# ============================================================================
CG_DORMANT=$(create_register_cg "dep-dormant-$STAMP") || bad "dormant CG create/register failed"
if [ -n "$CG_DORMANT" ]; then
  ESC=$(field "$(call ContextGraphStorage getRegistrationEscrow --json "[\"$CG_DORMANT\"]")" result)
  [ "$ESC" = "0" ] && ok "param=0: CG $CG_DORMANT escrowed nothing (esc=$ESC)" || bad "param=0 but escrow=$ESC (expected 0)"
else
  bad "could not resolve dormant CG on-chain id"
fi

# ============================================================================
act "2. ARM the param (governance) then register a CG — deposit must escrow"
# ============================================================================
SET=$(call ParametersStorage setContextGraphRegistrationDeposit --key "$GOV_KEY" --json "[\"$DEPOSIT\"]")
DEPOSIT_ARMED=1   # from here on, cleanup() must restore the baseline on any exit
TXH=$(field "$SET" txHash)
[ -n "$TXH" ] && ok "armed deposit param via governance (tx=$TXH)" || bad "setContextGraphRegistrationDeposit failed: $SET"
P1=$(field "$(call ParametersStorage contextGraphRegistrationDeposit)" result)
[ "$P1" = "$DEPOSIT" ] && ok "param now live = $P1 wei (1 TRAC)" || bad "param not set (got '$P1', want $DEPOSIT)"

CG_ARMED=$(create_register_cg "dep-armed-$STAMP") || bad "armed CG create/register failed (deposit pull / lazy-approve?)"
if [ -n "$CG_ARMED" ]; then
  ESC2=$(field "$(call ContextGraphStorage getRegistrationEscrow --json "[\"$CG_ARMED\"]")" result)
  if [ "$ESC2" = "$DEPOSIT" ]; then
    ok "ARMED: CG $CG_ARMED escrowed the full deposit gross (esc=$ESC2) via lazy approve-and-retry"
  else
    bad "armed register did not escrow the deposit (esc=$ESC2, expected $DEPOSIT)"
  fi
else
  bad "could not resolve armed CG on-chain id"
fi

# ============================================================================
act "3. TEARDOWN — reset param to 0 (dormant-regression safe)"
# ============================================================================
RST=$(call ParametersStorage setContextGraphRegistrationDeposit --key "$GOV_KEY" --json "[\"0\"]")
[ -n "$(field "$RST" txHash)" ] && log "param reset tx=$(field "$RST" txHash)"
P2=$(field "$(call ParametersStorage contextGraphRegistrationDeposit)" result)
if [ "$P2" = "0" ]; then ok "param reset to dormant (0)"; DEPOSIT_ARMED=0; else bad "param NOT reset (still $P2) — other suites may break!"; fi

echo
log "──────── SUMMARY ────────"
log "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && { log "ALL CG-DEPOSIT CHECKS PASSED"; exit 0; } || { log "SOME CHECKS FAILED"; exit 1; }
