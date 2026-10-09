// SPDX-License-Identifier: Apache-2.0

import { vi } from 'vitest';
import { resolveWorkspaceAgentRecipientKeys } from '@origintrail-official/dkg-publisher';
import type { TripleStore } from '@origintrail-official/dkg-storage';

/**
 * The recipient key/route fence of a hand-built agent host. Without it the
 * resolver would read `undefined` twice and compare equal, so a stub that forgot
 * it would pass every test while testing less; with it, a test moves
 * `revision` to model a write to a key or route fact.
 */
export function stubFence(revision = 0) {
  return { revision, ensureReady: vi.fn(async () => undefined), begin: vi.fn(() => () => undefined) };
}

/** The two revisions a recipient resolution of a private roster checks, quiet unless a test moves them. */
export function stubRecipientRevisions(store?: TripleStore) {
  return { recipientKeyCollect: { resolve: (agent: string) => {
    if (!store) throw new Error('recipient test host needs an owned store');
    return resolveWorkspaceAgentRecipientKeys(store, agent);
  } }, recipientKeyRouteFence: stubFence(), peerGateRevision: { read: () => '0:0' } };
}
