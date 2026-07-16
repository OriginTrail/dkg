/**
 * Daemon-wiring guard for `resolveMemoryAgentAddress` — the single point
 * where `runDaemonInner` picks the `agentAddress` it hands to
 * `ChatMemoryManager`.
 *
 * Why this file exists: the semantic regression test at
 * `packages/node-ui/test/chat-memory-persistence-regression.test.ts`
 * pins the write/read contract on `ChatMemoryManager` but constructs the
 * manager directly, so it can't catch a `lifecycle.ts` revert that puts
 * `agent.peerId` back into the constructor call. This file locks the
 * wiring by exercising the pure resolver that owns that decision.
 *
 * The resolver must stay in lockstep with the agent-side resolution in
 * `packages/agent/src/dkg-agent.ts::get assertion()` (which uses
 * `this.defaultAgentAddress ?? this.peerId`). Changes here need matching
 * changes there — and vice versa.
 */
import { describe, it, expect } from 'vitest';
import { resolveMemoryAgentAddress } from '../src/daemon.js';

describe('resolveMemoryAgentAddress — daemon WM-agentAddress wiring', () => {
  it(
    'returns the default agent address when one is registered (production case: ' +
      'must match what `agent.assertion.write` uses internally)',
    () => {
      const agent = {
        getDefaultAgentAddress: () => '0xbb765f337e251c1f18dfbec1a45ca56001b15e54',
        peerId: '12D3KooWFHUALUrdSfrVHSxtCRCJC9xvxS7nYfM6T1sbYVak9HTu',
      };
      expect(resolveMemoryAgentAddress(agent)).toBe(
        '0xbb765f337e251c1f18dfbec1a45ca56001b15e54',
      );
      expect(resolveMemoryAgentAddress(agent)).not.toBe(agent.peerId);
    },
  );

  it(
    'falls back to peerId when no default agent is registered (dev/test case: ' +
      '`autoRegisterDefaultAgent` skipped because no operational key)',
    () => {
      const agent = {
        getDefaultAgentAddress: () => undefined,
        peerId: '12D3KooWFHUALUrdSfrVHSxtCRCJC9xvxS7nYfM6T1sbYVak9HTu',
      };
      expect(resolveMemoryAgentAddress(agent)).toBe(
        '12D3KooWFHUALUrdSfrVHSxtCRCJC9xvxS7nYfM6T1sbYVak9HTu',
      );
    },
  );

  it(
    'an empty-string default-agent address is NOT coerced to the peerId fallback — ' +
      'the resolver mirrors the agent-side `?? this.peerId` nullish-coalescing exactly. ' +
      'Returning peerId here when the agent side returns "" would recreate the exact ' +
      'write/read-graph-URI mismatch #277 fixed.',
    () => {
      const agent = {
        getDefaultAgentAddress: () => '',
        peerId: '12D3KooWFHUALUrdSfrVHSxtCRCJC9xvxS7nYfM6T1sbYVak9HTu',
      };
      // `??` treats '' as defined, so the resolver returns '' — the same
      // value `this.defaultAgentAddress ?? this.peerId` produces in
      // `dkg-agent.ts::get assertion()`. Both sides stay aligned, which
      // is the only invariant that matters for #277. Whether empty
      // string is semantically valid as an agentAddress is a separate
      // caller-bug question; fixing it here would silently desync from
      // the agent side.
      expect(resolveMemoryAgentAddress(agent)).toBe('');
    },
  );
});
