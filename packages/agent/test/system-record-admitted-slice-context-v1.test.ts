import { describe, expect, it } from 'vitest';

import {
  createAgentProfileAdmittedSliceContextAuthorityV1,
} from '../src/system-records/admitted-slice-context-v1.js';

describe('agent-profile admitted slice context authority', () => {
  it('mints a canonical context with a fixed nonrenewable deadline', () => {
    let nowMs = 1_000;
    const authority = createAgentProfileAdmittedSliceContextAuthorityV1(() => nowMs);
    const context = authority.mint(4_000);

    expect(authority.inspect(context)).toEqual({
      nowMs: 1_000,
      admittedDeadlineMs: 4_000,
    });
    nowMs = 2_500;
    expect(authority.inspect(context)).toEqual({
      nowMs: 2_500,
      admittedDeadlineMs: 4_000,
    });
  });

  it('rejects forged and cross-authority contexts', () => {
    const first = createAgentProfileAdmittedSliceContextAuthorityV1(() => 1_000);
    const second = createAgentProfileAdmittedSliceContextAuthorityV1(() => 1_000);
    const secondContext = second.mint(4_000);

    expect(() => Reflect.apply(first.inspect, first, [Object.freeze({})]))
      .toThrow(/invalid or revoked/);
    expect(() => first.inspect(secondContext)).toThrow(/invalid or revoked/);
    expect(second.inspect(secondContext)).toEqual({
      nowMs: 1_000,
      admittedDeadlineMs: 4_000,
    });
  });

  it('revokes one slice without invalidating a later slice', () => {
    const authority = createAgentProfileAdmittedSliceContextAuthorityV1(() => 1_000);
    const first = authority.mint(4_000);
    authority.revoke(first);
    const second = authority.mint(5_000);

    expect(() => authority.inspect(first)).toThrow(/invalid or revoked/);
    expect(authority.inspect(second)).toEqual({
      nowMs: 1_000,
      admittedDeadlineMs: 5_000,
    });
  });
});
