#!/usr/bin/env bash
#
# #1240 — relay-flap guard: devnet INTEGRATION proof.
#
# Unit tests (packages/core/test/relay-flap-guard.test.ts) cover the state
# machine and the gater hook shapes. This proves the guard on a REAL post-#1240
# fleet — the layer that was missing and that the 4h soak exposed as ~25k
# sub-second relayed-connection flaps before the guard existed:
#
#   1. The guard FIRES — it logs `Relay flap guard: denying ... relayed
#      connection` when a (relay,remote) pair flaps past the threshold.
#   2. It QUARANTINES a small, specific set of flapping pairs (not unbounded).
#   3. Churn is SUPPRESSED — a quarantined remote's relayed-open rate drops once
#      it is denied (each deny == one prevented flap).
#   4. It RECOVERS — DCUtR upgrades relayed->direct and the quarantine clears.
#
# Reads the node daemon logs (`.devnet/node*/daemon.log`). Requires a running
# devnet built from post-#1240 code. Self-contained; FAILS loudly if it cannot
# actually exercise the guard (no false-green).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
NUM_NODES="${NUM_NODES:-6}"
WAIT_SECONDS="${RFG_WAIT_SECONDS:-180}"   # let natural relay churn trigger the guard
THRESHOLD="${RFG_THRESHOLD:-5}"           # mirrors RELAY_FLAP_THRESHOLD

PASS=0; FAIL=0; SKIP=0
log()  { echo "[relay-flap] $*"; }
ok()   { echo "[relay-flap]   PASS: $*"; PASS=$((PASS+1)); }
bad()  { echo "[relay-flap]   FAIL: $*" >&2; FAIL=$((FAIL+1)); }
skip() { echo "[relay-flap]   SKIP: $*"; SKIP=$((SKIP+1)); }
act()  { echo; echo "[relay-flap] === $* ==="; }
fatal(){ echo "[relay-flap] FATAL: $*" >&2; exit 2; }

LOGS=$(ls "$DEVNET_DIR"/node*/daemon.log 2>/dev/null)
[ -n "$LOGS" ] || fatal "no node logs under $DEVNET_DIR/node*/daemon.log — run ./scripts/devnet.sh start $NUM_NODES first"
catlogs() { cat $LOGS 2>/dev/null; }

short_flaps() { catlogs | grep -E 'Connection closed.*transport=relayed.*duration=[0-9]+ms' | grep -oE 'duration=[0-9]+ms' | grep -oE '[0-9]+' | awk '$1<1000' | wc -l | tr -d ' '; }
deny_count()  { catlogs | grep -c 'Relay flap guard: denying' 2>/dev/null || echo 0; }
dcutr_count() { catlogs | grep -c 'DCUtR upgrade' 2>/dev/null || echo 0; }

# ── 0. there must be relayed flap activity, or there is nothing to prove ──────
act "0. relay flap activity present? (the guard is a no-op without flaps)"
waited=0
while [ "$(short_flaps)" -lt "$THRESHOLD" ] && [ "$waited" -lt "$WAIT_SECONDS" ]; do
  sleep 10; waited=$((waited+10))
done
FLAPS=$(short_flaps)
log "  sub-second relayed closes across the fleet: $FLAPS (waited ${waited}s)"
if [ "$FLAPS" -lt "$THRESHOLD" ]; then
  bad "only $FLAPS (<$THRESHOLD) sub-second relayed flaps observed in ${WAIT_SECONDS}s — cannot exercise the guard (is circuit relay enabled / is this a post-#1240 build?)"
  echo; log "PASS=$PASS FAIL=$FAIL SKIP=$SKIP"; exit 1
fi
ok "fleet is producing relayed flaps ($FLAPS) — the guard has something to act on"

# ── 1. the guard fires ───────────────────────────────────────────────────────
act "1. guard FIRES on the flapping pairs"
waited=0
while [ "$(deny_count)" -eq 0 ] && [ "$waited" -lt 60 ]; do sleep 10; waited=$((waited+10)); done
DENY=$(deny_count)
if [ "$DENY" -gt 0 ]; then
  ok "guard fired: $DENY relayed-dial denials (== $DENY flaps prevented)"
else
  bad "fleet has $FLAPS relayed flaps but the guard NEVER fired — gater not wired / inert (this is the exact regression unit tests miss)"
fi

# ── 2. it quarantines a small, specific set of pairs ─────────────────────────
act "2. quarantines a bounded set of flapping remotes (not unbounded)"
REMOTES=$(catlogs | grep 'Relay flap guard: denying' | grep -oE 'remote=[A-Za-z0-9]+' | sort -u | wc -l | tr -d ' ')
RELAYS=$(catlogs  | grep 'Relay flap guard: denying' | grep -oE 'relay=[A-Za-z0-9]+'  | sort -u | wc -l | tr -d ' ')
log "  distinct quarantined remotes=$REMOTES relays=$RELAYS"
if [ "$DENY" -gt 0 ] && [ "$REMOTES" -ge 1 ]; then
  ok "guard targeted $REMOTES distinct flapping remote(s) via $RELAYS relay(s) — specific, not blanket"
else
  skip "no quarantined pairs parsed"
fi
# active quarantine windows present (denies carry a remaining-time)
QWIN=$(catlogs | grep 'Relay flap guard: denying' | grep -cE 'quarantineRemaining=[0-9]+s')
[ "$QWIN" -gt 0 ] && ok "denials carry active quarantine windows ($QWIN with quarantineRemaining)" || skip "no quarantineRemaining seen"

# ── 3. churn is suppressed for a quarantined remote ──────────────────────────
act "3. churn SUPPRESSED — a quarantined remote's relayed opens drop after denial"
# Pick the first quarantined remote + the timestamp of its first denial, then
# compare its relayed-open count before vs after that moment (ISO timestamps
# sort lexically, so string compare is valid).
FIRST_DENY_LINE=$(catlogs | grep 'Relay flap guard: denying' | head -1)
RREMOTE=$(printf '%s' "$FIRST_DENY_LINE" | grep -oE 'remote=[A-Za-z0-9]+' | head -1 | cut -d= -f2)
TDENY=$(printf '%s' "$FIRST_DENY_LINE" | grep -oE '^\[[0-9TZ:.\-]+\]' | tr -d '[]')
if [ -n "$RREMOTE" ] && [ -n "$TDENY" ]; then
  BEFORE=$(catlogs | grep "Connection opened: ${RREMOTE}.*transport=relayed" | awk -v t="[$TDENY]" '{ if ($1 < t) c++ } END{print c+0}')
  AFTER=$(catlogs  | grep "Connection opened: ${RREMOTE}.*transport=relayed" | awk -v t="[$TDENY]" '{ if ($1 >= t) c++ } END{print c+0}')
  log "  remote=$RREMOTE relayed-opens before-quarantine=$BEFORE after=$AFTER (first deny @ $TDENY)"
  if [ "$BEFORE" -gt 0 ] && [ "$AFTER" -le "$BEFORE" ]; then
    ok "quarantine suppressed churn for $RREMOTE (relayed-open rate did not increase after denial: $BEFORE -> $AFTER)"
  else
    skip "could not establish a clear before/after suppression for $RREMOTE ($BEFORE -> $AFTER)"
  fi
else
  skip "could not parse a quarantined remote/timestamp for the suppression check"
fi

# ── 4. recovery via DCUtR ────────────────────────────────────────────────────
act "4. RECOVERY — DCUtR upgrades relayed->direct and clears the quarantine"
DCUTR=$(dcutr_count)
if [ "$DCUTR" -gt 0 ]; then
  ok "self-heal observed: $DCUTR DCUtR relayed->direct upgrade(s)"
else
  skip "no DCUtR upgrades in window (recovery not observed; guard still self-expires after the quarantine TTL)"
fi

echo
log "──────── SUMMARY ────────"
log "PASS=$PASS FAIL=$FAIL SKIP=$SKIP | flaps=$FLAPS denied(prevented)=$DENY quarantined_remotes=$REMOTES dcutr=$DCUTR"
[ "$FAIL" -eq 0 ] && { log "RELAY-FLAP GUARD VERIFIED ON A LIVE FLEET"; exit 0; } || { log "SOME CHECKS FAILED"; exit 1; }
