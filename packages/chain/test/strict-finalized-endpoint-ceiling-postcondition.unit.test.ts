/**
 * The attempt ceiling used to be enforced by the config validator rejecting any
 * pool larger than `CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1`. Session
 * selection replaced that rejection, so the ceiling is now satisfied by
 * construction — and the config keeps a postcondition on the result.
 *
 * That postcondition is UNREACHABLE from production callers: the config passes
 * the ceiling itself as the bound, so a correct selector can never exceed it.
 * An unreachable guard is normally a check that cannot fail, which is why it is
 * worth stating what it is actually for and proving it discriminates.
 *
 * What it is for: the runner never reads `maxAttempts`. It attempts one endpoint
 * per entry of `profile.endpoints` (`strict-current-finalized-evm-lifecycle.ts`),
 * while `CONTROL_EIP1271_MAX_ATTEMPTS_V1 = 2` is attested in the control
 * envelope and verified at `current-finalized-evm-call.ts:182`. So the attested
 * attempt count is truthful only while something bounds this list. Without the
 * postcondition that "something" lives entirely inside another module, and a
 * regression there would widen the real attempt count while the attestation kept
 * claiming two.
 *
 * These tests stub the selector to a value a broken selector could produce, and
 * assert the config fails closed rather than forwarding it. Mocking the
 * collaborator is the only way to reach the branch — the real one is correct.
 */
import { describe, expect, it, vi } from 'vitest';

const selectStrictFinalizedEndpointSessionV1 = vi.hoisted(() => vi.fn());

vi.mock('../src/strict-finalized-endpoint-session.js', () => ({
  selectStrictFinalizedEndpointSessionV1,
}));

const { snapshotStrictCurrentFinalizedEvmConfigV1 } = await import(
  '../src/strict-current-finalized-evm-config.js'
);

const CHAIN_ID = '84532';
const POOL = Object.freeze([
  'https://a.example.com/rpc',
  'https://b.example.com/rpc',
  'https://c.example.com/rpc',
]);

function selection(selected: readonly string[]) {
  return Object.freeze([...selected]);
}

describe('the attested attempt ceiling is asserted where it is attested', () => {

  it('fails closed when the selector returns more endpoints than the ceiling', () => {
    // Exactly what a regressed bound would produce: the whole pool, unsliced.
    selectStrictFinalizedEndpointSessionV1.mockReturnValue(selection(POOL));

    expect(() => snapshotStrictCurrentFinalizedEvmConfigV1({
      chainId: CHAIN_ID,
      endpoints: POOL,
    } as never)).toThrow('exceeded the attested attempt ceiling');
  });

  it('accepts a selection at the ceiling, so the guard is a bound and not a ban', () => {
    // The discriminator. Without this case the test above would also pass if the
    // config rejected EVERY selection, which would break the product entirely.
    selectStrictFinalizedEndpointSessionV1.mockReturnValue(selection(POOL.slice(0, 2)));

    const config = snapshotStrictCurrentFinalizedEvmConfigV1({
      chainId: CHAIN_ID,
      endpoints: POOL,
    } as never);
    expect(config.endpoints).toEqual([POOL[0], POOL[1]]);
  });

  it('accepts a single endpoint, the other side of the bound', () => {
    selectStrictFinalizedEndpointSessionV1.mockReturnValue(selection(POOL.slice(0, 1)));

    const config = snapshotStrictCurrentFinalizedEvmConfigV1({
      chainId: CHAIN_ID,
      endpoints: POOL,
    } as never);
    expect(config.endpoints).toEqual([POOL[0]]);
  });
});
