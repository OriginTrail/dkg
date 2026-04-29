/**
 * gossip envelope signing
 * defaults to fail-closed.
 *
 * Before this round, `strictGossipEnvelope` defaulted to `false`
 * (lenient-with-warn) to ease rolling upgrades. That made the whole
 * signing layer bypassable — a malicious peer could simply strip the
 * envelope, fall into the `raw` bucket, and have their payload
 * dispatched as legacy gossip. Round 14 flipped the default: strict
 * mode is now the fail-closed baseline. Operators mid-upgrade can opt
 * OUT via `strictGossipEnvelope: false` or `DKG_STRICT_GOSSIP_ENVELOPE=0`,
 * and an env-level OPT-IN always overrides a config opt-out (same
 * precedence we use for `strictWmCrossAgentAuth`).
 *
 * This file pins the resolver in isolation so regressions show up
 * here instead of deep in the gossip ingress path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveStrictGossipEnvelopeMode } from '../src/dkg-agent.js';

describe('resolveStrictGossipEnvelopeMode', () => {
  // Guard against ambient DKG_STRICT_GOSSIP_ENVELOPE leaking in from a
  // developer shell — always pass the env value explicitly.
  const originalEnv = process.env.DKG_STRICT_GOSSIP_ENVELOPE;
  beforeEach(() => {
    delete process.env.DKG_STRICT_GOSSIP_ENVELOPE;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DKG_STRICT_GOSSIP_ENVELOPE;
    else process.env.DKG_STRICT_GOSSIP_ENVELOPE = originalEnv;
  });

  it('default (no config, no env) → STRICT (fail-closed)', () => {
    expect(resolveStrictGossipEnvelopeMode({})).toBe(true);
  });

  it('config: true → strict', () => {
    expect(resolveStrictGossipEnvelopeMode({ configValue: true })).toBe(true);
  });

  it('config: false → lenient (explicit opt-out for rolling upgrades)', () => {
    expect(resolveStrictGossipEnvelopeMode({ configValue: false })).toBe(false);
  });

  it('env: "1" → strict, even if config opts out', () => {
    expect(
      resolveStrictGossipEnvelopeMode({ configValue: false, envValue: '1' }),
    ).toBe(true);
  });

  it('env: "true" → strict (alias for "1")', () => {
    expect(
      resolveStrictGossipEnvelopeMode({ configValue: false, envValue: 'true' }),
    ).toBe(true);
  });

  it('env: "yes" → strict (alias for "1")', () => {
    expect(
      resolveStrictGossipEnvelopeMode({ configValue: false, envValue: 'yes' }),
    ).toBe(true);
  });

  it('env: "0" → lenient, even if config says strict', () => {
    expect(
      resolveStrictGossipEnvelopeMode({ configValue: true, envValue: '0' }),
    ).toBe(false);
  });

  it('env: "false" → lenient (alias for "0")', () => {
    expect(
      resolveStrictGossipEnvelopeMode({ configValue: true, envValue: 'false' }),
    ).toBe(false);
  });

  it('env: unrecognised value → falls through to config', () => {
    // `maybe`, empty string, etc. — anything that isn't one of the two
    // explicit truthy/falsy token sets is treated as "env not set" so
    // the config precedence kicks in. This is important because a typo
    // like `DKG_STRICT_GOSSIP_ENVELOPE=enabled` must NOT be a silent
    // opt-out.
    expect(
      resolveStrictGossipEnvelopeMode({ configValue: true, envValue: 'maybe' }),
    ).toBe(true);
    expect(
      resolveStrictGossipEnvelopeMode({ configValue: false, envValue: 'maybe' }),
    ).toBe(false);
  });

  it('env is case-insensitive', () => {
    expect(
      resolveStrictGossipEnvelopeMode({ configValue: false, envValue: 'TRUE' }),
    ).toBe(true);
    expect(
      resolveStrictGossipEnvelopeMode({ configValue: true, envValue: 'NO' }),
    ).toBe(false);
  });

  it('config undefined + env undefined → strict (the r14-1 flip)', () => {
    // The whole point of r14-1: the AMBIGUOUS case must be strict,
    // not lenient. Before the flip this returned `false` which made
    // the signing layer opt-in rather than protective.
    expect(
      resolveStrictGossipEnvelopeMode({ configValue: undefined, envValue: undefined }),
    ).toBe(true);
  });
});
