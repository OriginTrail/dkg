#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI_ENTRY="$ROOT_DIR/packages/cli/dist/cli.js"

if [[ -z "${PRIVATE_KEY:-}" ]]; then
  cat >&2 <<'EOF'
PRIVATE_KEY is required.

Example:
  PRIVATE_KEY=0xabc... ./scripts/publisher-smoke-test.sh

Optional env vars:
  DKG_HOME=/tmp/dkg-home        Use a custom DKG home (defaults to a temp dir)
  START_DAEMON=1                Start `dkg start` in the background for the smoke
  SEED_JOB=1                    Seed a real workspace operation + async publisher job
EOF
  exit 1
fi

export DKG_HOME="${DKG_HOME:-$(mktemp -d)}"
export START_DAEMON="${START_DAEMON:-0}"
export SEED_JOB="${SEED_JOB:-1}"

cleanup() {
  if [[ -n "${DAEMON_PID:-}" ]]; then
    kill "$DAEMON_PID" >/dev/null 2>&1 || true
    wait "$DAEMON_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "Using DKG_HOME=$DKG_HOME"

cd "$ROOT_DIR"

echo
echo "== Building CLI and publisher =="
pnpm --filter @origintrail-official/dkg-publisher build
pnpm --filter @origintrail-official/dkg build

echo
echo "== Adding publisher wallet =="
node "$CLI_ENTRY" publisher wallet add "$PRIVATE_KEY"

echo
echo "== Listing publisher wallets =="
node "$CLI_ENTRY" publisher wallet list

echo
echo "== Enabling publisher in dkg start =="
node "$CLI_ENTRY" publisher enable --poll-interval 1000 --error-backoff 1000

if [[ "$START_DAEMON" == "1" ]]; then
  echo
  echo "== Starting daemon in background =="
  node "$CLI_ENTRY" start >"$DKG_HOME/publisher-smoke-daemon.log" 2>&1 &
  DAEMON_PID=$!
  sleep 5
  echo "Daemon PID: $DAEMON_PID"
  echo "Daemon log: $DKG_HOME/publisher-smoke-daemon.log"
fi

if [[ "$SEED_JOB" == "1" ]]; then
  echo
  echo "== Seeding a workspace operation and async publisher job =="
  export SMOKE_PRIVATE_KEY="$PRIVATE_KEY"
  node --input-type=module <<'EOF'
import { join } from 'node:path';
import { createTripleStore } from '@origintrail-official/dkg-storage';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { DKGPublisher, TripleStoreAsyncLiftPublisher } from '@origintrail-official/dkg-publisher';

const dkgHome = process.env.DKG_HOME;
const privateKey = process.env.SMOKE_PRIVATE_KEY;
const store = await createTripleStore({
  backend: 'oxigraph-worker',
  options: { path: join(dkgHome, 'store.nq') },
});

const walletAddress = '0x1111111111111111111111111111111111111111';
const keypair = await generateEd25519Keypair();
const publisher = new DKGPublisher({
  store,
  chain: new MockChainAdapter('mock:31337', walletAddress),
  eventBus: new TypedEventBus(),
  keypair,
  publisherPrivateKey: privateKey,
  publisherNodeIdentityId: 1n,
});

const write = await publisher.writeToWorkspace('music-social', [
  { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
  { subject: 'urn:local:/rihana', predicate: 'http://schema.org/genre', object: '"Pop"', graph: '' },
], { publisherPeerId: 'peer-1' });

const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
const jobId = await asyncPublisher.lift({
  workspaceId: 'workspace-main',
  workspaceOperationId: write.workspaceOperationId,
  roots: ['urn:local:/rihana'],
  paranetId: 'music-social',
  namespace: 'aloha',
  scope: 'person-profile',
  transitionType: 'CREATE',
  authority: { type: 'owner', proofRef: 'proof:owner:1' },
});

console.log(`Seeded job: ${jobId}`);
await store.close();
EOF
fi

echo
echo "== Listing publisher jobs =="
node "$CLI_ENTRY" publisher jobs

echo
echo "== Listing accepted publisher jobs =="
node "$CLI_ENTRY" publisher jobs --status accepted

echo
echo "If a job was seeded above, inspect it with:"
echo "  node $CLI_ENTRY publisher job <JOB_ID>"
echo "  node $CLI_ENTRY publisher job <JOB_ID> --payload"

echo
echo "To disable publisher startup later:"
echo "  node $CLI_ENTRY publisher disable"
