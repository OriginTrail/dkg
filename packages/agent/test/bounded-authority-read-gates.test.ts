// SPDX-License-Identifier: Apache-2.0

/**
 * Which gates are allowed to read a bounded-freshness authority, and which are
 * not.
 *
 * `freshness: 'bounded'` lets the node's own event index answer instead of the
 * chain. That is safe exactly where being briefly behind DELAYS a decision the
 * next read corrects — a member added a moment ago is denied and retries; one
 * removed a moment ago is admitted for at most the index's freshness bound.
 *
 * It is not safe where the answer hands over something that outlives the bound.
 * Issuing a sender key is the clear case: the epoch is keyed on the membership
 * hash, so a stale roster does not merely delay the revocation — it wraps the
 * key to the removed member and does not re-wrap until the roster catches up.
 *
 * These tests pin the split, so that widening it has to be deliberate.
 */

import { describe, expect, it, vi } from 'vitest';

import { WorkspaceCryptoMethods } from '../src/dkg-agent-crypto.js';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';

type Recorded = { freshness?: 'live' | 'bounded' } | undefined;

/** A receiver that records the options each authority read was issued with. */
function receiver(recorded: Recorded[]) {
  return {
    chain: {
      getContextGraphLiveAuthority: vi.fn(async (_id: bigint, options?: Recorded) => {
        recorded.push(options);
        return { active: true, accessPolicy: 1, participantAgents: [] };
      }),
      isContextGraphActiveOnChain: vi.fn(async () => true),
      getContextGraphAccessPolicy: vi.fn(async () => 1),
    },
    warnedMissingCgLivenessProbe: false,
    lastLiveAuthorityFallbackWarnAt: 0,
    raceChainPolicyRead: async (start: (signal: AbortSignal) => unknown) => (
      start(new AbortController().signal)
    ),
    log: { warn: vi.fn(), info: vi.fn() },
    onChainAccessPolicyCache: new Map<string, unknown>(),
  };
}

/**
 * `resolveLiveOnChainAccessPolicyState` is where the dependency bundle is
 * built, so it is the narrowest place the freshness choice can be observed
 * reaching the chain. It is `protected`, which is a compile-time notion only —
 * the prototype method is the same function the agent calls.
 */
const resolvePolicyState = (
  WorkspaceCryptoMethods.prototype as unknown as {
    resolveLiveOnChainAccessPolicyState(
      onChainId: string,
      opCtx?: unknown,
      options?: { signal?: AbortSignal; freshness?: 'live' | 'bounded' },
    ): Promise<unknown>;
  }
).resolveLiveOnChainAccessPolicyState;

function readPolicy(
  host: ReturnType<typeof receiver>,
  options?: { freshness?: 'live' | 'bounded' },
) {
  return resolvePolicyState.call(host as never, '7', undefined, options);
}

describe('bounded-freshness authority reads', () => {
  describe('the chain read carries the caller\'s choice', () => {
    it('asks for a bounded read when the caller says its decision can wait', async () => {
      const recorded: Recorded[] = [];
      await readPolicy(receiver(recorded), { freshness: 'bounded' });

      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.freshness).toBe('bounded');
    });

    it.each([
      ['no options are supplied', undefined],
      ['freshness is explicitly live', { freshness: 'live' as const }],
    ])('asks for a live read when %s', async (_label, options) => {
      const recorded: Recorded[] = [];
      await readPolicy(receiver(recorded), options);

      expect(recorded).toHaveLength(1);
      // LIVE IS THE DEFAULT AND MUST STAY THE DEFAULT. A caller that has not
      // reasoned about staleness must never be silently downgraded.
      expect(recorded[0]?.freshness).toBe('live');
    });
  });

  describe('the authority resolver forwards it unchanged', () => {
    function resolveHost(seen: Array<{ freshness?: string } | undefined>) {
      return {
        resolveContextGraphRegistrationBinding: vi.fn(async () => ({
          kind: 'registered', onChainId: 7n,
        })),
        resolveLiveOnChainAccessPolicyState: vi.fn(async (
          _id: string, _ctx: unknown, options?: { freshness?: string },
        ) => {
          seen.push(options);
          return { kind: 'available', accessPolicy: 0 };
        }),
      };
    }

    it('passes bounded through to the policy state read', async () => {
      const seen: Array<{ freshness?: string } | undefined> = [];
      await ContextGraphResolveMethods.prototype.resolveRegisteredContextGraphAuthority
        .call(resolveHost(seen) as never, 'cg-1', { freshness: 'bounded' } as never);

      expect(seen[0]?.freshness).toBe('bounded');
    });

    it('omits freshness entirely when the caller did not choose', async () => {
      // Absent rather than `'live'`: the default belongs to one place, and a
      // second default here could drift away from it.
      const seen: Array<{ freshness?: string } | undefined> = [];
      await ContextGraphResolveMethods.prototype.resolveRegisteredContextGraphAuthority
        .call(resolveHost(seen) as never, 'cg-1');

      expect(seen[0]).not.toHaveProperty('freshness');
    });
  });

  describe('the split between read gates and key gates', () => {
    // A guard against the flip spreading by copy-paste. If a new call site
    // needs bounded freshness, it belongs in the first list with a reason.
    const source = (path: string): string => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      return readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
    };

    it('flips exactly the read gates, and nothing else', () => {
      const files = [
        'dkg-agent-query.ts',
        'dkg-agent-swm-host.ts',
        'dkg-agent-crypto.ts',
        'dkg-agent-publish.ts',
      ];
      const flipped = files.filter((file) => source(file).includes("freshness: 'bounded'"));

      // `dkg-agent-query.ts` carries the read-authority funnel behind
      // `cgAuth.query`, `cgAuth.canRead` and `cgAuth.readAuth`, and
      // `cgAuth.vmReconcile` reaches it through `canReadContextGraph`.
      // `dkg-agent-swm-host.ts` carries `cgAuth.vmSizing`.
      expect(flipped.sort()).toEqual(['dkg-agent-query.ts', 'dkg-agent-swm-host.ts']);
    });

    it('never flips the key-issuance or plaintext-downgrade paths', () => {
      // `dkg-agent-crypto.ts` holds `cgAuth.recipients` and
      // `cgAuth.senderKeyAccept`; `dkg-agent-publish.ts` holds
      // `cgAuth.curatedProbe` and `cgAuth.curatedKeyCtx`. A stale roster at any
      // of them hands over a key or permits plaintext, and neither is repaired
      // by the next read.
      for (const file of ['dkg-agent-crypto.ts', 'dkg-agent-publish.ts']) {
        expect(source(file)).not.toContain("freshness: 'bounded'");
      }
    });
  });
});
