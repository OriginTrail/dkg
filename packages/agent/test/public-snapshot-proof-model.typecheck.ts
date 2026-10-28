import type { PublicSnapshotProofRuntime } from '../src/public-snapshot-proof-runtime.js';
import type { SnapshotSourceChallenge } from '../src/public-snapshot-proof-wire.js';
import { sourceProofCodec } from '../src/public-snapshot-source-proof.js';
import { cacheProofCodec } from '../src/core-chain-cache-proof.js';

declare const runtime: PublicSnapshotProofRuntime;
declare const challenge: SnapshotSourceChallenge;

void runtime.respond('peer', () => ({
  assertCurrent: () => {}, validate: async () => {}, codec: sourceProofCodec(challenge),
  // @ts-expect-error A renamed identity field cannot be signed or encoded as a source proof.
  proof: identityId => ({ identity: identityId }),
}));
void runtime.respond('peer', () => ({
  assertCurrent: () => {}, validate: async () => {}, codec: cacheProofCodec(challenge),
  // @ts-expect-error Cache proofs require the registration chain and deployment as well as identity.
  proof: identityId => ({ identityId }),
}));
void runtime.respond('peer', () => ({
  assertCurrent: () => {}, validate: async () => {}, codec: cacheProofCodec(challenge),
  proof: identityId => ({ chainId: 'gnosis:100', deploymentId: 'gnosis:100:hub=registry', identityId }),
}));
