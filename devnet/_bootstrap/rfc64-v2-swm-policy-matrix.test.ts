import { describe, expect, it } from 'vitest';

import {
  RFC64_V2_FUTURE_TRANSITION_CAPABILITY,
  RFC64_V2_REQUIRED_PRODUCT_CAPABILITIES,
  digestRfc64V2SwmBindings,
  inspectRfc64V2ProductCapabilities,
  requireRfc64V2ProductCapabilities,
  verifyRfc64V2SwmPolicyMatrix,
  type Rfc64V2SwmCellObservation,
} from './rfc64-v2-swm-policy-matrix.js';

const MEMBER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OUTSIDER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function digest(byte: string, prefix = 'sha256:'): string {
  return `${prefix}${byte.repeat(64)}`;
}

function cell(
  name: Rfc64V2SwmCellObservation['cell'],
  index: number,
  accessPolicy: 0 | 1,
  publishPolicy: 0 | 1,
): Rfc64V2SwmCellObservation {
  const authorAgentAddress = `0x${String(index + 1).padStart(40, '0')}`;
  const number = BigInt(index + 11);
  const kaId = ((BigInt(authorAgentAddress) << 96n) | number).toString();
  const contentSha256 = digest(String(index + 1));
  const positive = {
    agentAddress: MEMBER,
    bindingCount: 2,
    contentSha256,
    httpStatus: 200,
    leakedMarker: false,
    nodeNumber: 6,
    outcome: 'applied' as const,
  };
  return {
    accessPolicy,
    assertionUri: `did:dkg:context-graph:matrix-${index}/assertion/${authorAgentAddress}/asset`,
    authorAgentAddress,
    cell: name,
    contentSha256,
    contextGraphId: `matrix-${index}`,
    kaId,
    memberRead: positive,
    merkleRoot: digest(String(index + 5), '0x'),
    outsiderRead: accessPolicy === 0
      ? { ...positive, agentAddress: OUTSIDER, nodeNumber: 4 }
      : {
          agentAddress: OUTSIDER,
          bindingCount: 0,
          contentSha256: null,
          httpStatus: 403,
          leakedMarker: false,
          nodeNumber: 4,
          outcome: 'denied',
        },
    policyLifecycle: 'immutable-per-cell-snapshot',
    publishPolicy,
    tripleCount: 2,
    txHash: digest(((index + 9) % 16).toString(16), '0x'),
    ual: `did:dkg:otp:20430/${authorAgentAddress}/${number}`,
  };
}

function fixture(): Rfc64V2SwmCellObservation[] {
  return [
    cell('public-open', 0, 0, 1),
    cell('public-curated', 1, 0, 0),
    cell('private-open', 2, 1, 1),
    cell('private-curated', 3, 1, 0),
  ];
}

describe('RFC-64 V2 rich-scenario SWM policy matrix contract', () => {
  it('accepts the exact four cells and proves publishPolicy-neutral SWM behavior', () => {
    const verified = verifyRfc64V2SwmPolicyMatrix(fixture());
    expect(verified.status).toBe('PASS');
    expect(verified.publishPolicyConsultedBySwm).toBe(false);
    expect(verified.policyLifecycle).toBe('four-independent-immutable-snapshots');
    expect(verified.publishPolicyParity).toHaveLength(2);
    expect(verified.publishPolicyParity[0]!.vector).toEqual(
      verified.publishPolicyParity[0]!.vector,
    );
  });

  it('rejects missing cells, wrong axes, UAL/kaId mismatch, and content mismatch', () => {
    expect(() => verifyRfc64V2SwmPolicyMatrix(fixture().slice(0, 3)))
      .toThrow(/exactly four/);

    const wrongAxes = fixture();
    wrongAxes[1] = { ...wrongAxes[1]!, publishPolicy: 1 };
    expect(() => verifyRfc64V2SwmPolicyMatrix(wrongAxes)).toThrow(/publishPolicy/);

    const wrongKaId = fixture();
    wrongKaId[0] = { ...wrongKaId[0]!, kaId: '1' };
    expect(() => verifyRfc64V2SwmPolicyMatrix(wrongKaId)).toThrow(/packed UAL identity/);

    const mismatch = fixture();
    mismatch[0] = {
      ...mismatch[0]!,
      memberRead: { ...mismatch[0]!.memberRead, contentSha256: digest('f') },
    };
    expect(() => verifyRfc64V2SwmPolicyMatrix(mismatch)).toThrow(/contentSha256/);
  });

  it('rejects a private outsider leak and publish-axis-dependent behavior', () => {
    const leak = fixture();
    leak[2] = {
      ...leak[2]!,
      outsiderRead: {
        ...leak[2]!.outsiderRead,
        bindingCount: 2,
        contentSha256: leak[2]!.contentSha256,
        httpStatus: 200,
        leakedMarker: true,
        outcome: 'applied',
      },
    };
    expect(() => verifyRfc64V2SwmPolicyMatrix(leak)).toThrow(/outsiderRead\.outcome/);

    const drift = fixture();
    drift[1] = {
      ...drift[1]!,
      outsiderRead: { ...drift[1]!.outsiderRead, bindingCount: 1 },
    };
    expect(() => verifyRfc64V2SwmPolicyMatrix(drift)).toThrow(/bindingCount/);
  });

  it('normalizes SPARQL bindings before hashing', () => {
    const left = digestRfc64V2SwmBindings([
      { p: { value: 'urn:p:2' }, o: 'two' },
      { o: { value: 'one' }, p: 'urn:p:1' },
    ]);
    const right = digestRfc64V2SwmBindings([
      { p: 'urn:p:1', o: 'one' },
      { o: 'two', p: 'urn:p:2' },
    ]);
    expect(left).toBe(right);
  });

  it('reports missing product seams deterministically and keeps transitions future-scoped', () => {
    const partial = inspectRfc64V2ProductCapabilities({
      acceptRfc64CatalogAccessSnapshotV1() {},
    });
    expect(partial.missing).toEqual([
      'publishAuthorCatalogGenesisV1',
      'publishAuthorCatalogExactSetSuccessorV1',
    ]);
    expect(() => requireRfc64V2ProductCapabilities(partial)).toThrow(
      'RFC64_V2_PRODUCT_CAPABILITIES_UNAVAILABLE: '
        + 'publishAuthorCatalogGenesisV1, publishAuthorCatalogExactSetSuccessorV1',
    );
    expect(partial.futureTransitionCapability).toBe(false);

    const complete = Object.fromEntries([
      ...RFC64_V2_REQUIRED_PRODUCT_CAPABILITIES,
      RFC64_V2_FUTURE_TRANSITION_CAPABILITY,
    ].map((name) => [name, () => undefined]));
    const inspection = inspectRfc64V2ProductCapabilities(complete);
    expect(inspection.missing).toEqual([]);
    expect(inspection.futureTransitionCapability).toBe(true);
  });
});
