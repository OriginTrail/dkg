import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  CONTEXT_GRAPH_NAME_MAX_REQUEST_BYTES,
  PROTOCOL_CONTEXT_GRAPH_NAME,
  createContextGraphNameRequestHandler,
  decodeContextGraphNameRequest,
  decodeContextGraphNameResponse,
  encodeContextGraphNameRequest,
  encodeContextGraphNameResponse,
  type ContextGraphNameRevealSource,
} from '../src/context-graph-name-protocol.js';

const PUBLIC_ID = 'acme-fun-facts';
const PRIVATE_ID = 'acme-board-minutes';
const hashOf = (id: string) => ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function source(
  policies: Record<string, 'public' | 'private' | 'unavailable'>,
  gate?: Promise<void>,
): ContextGraphNameRevealSource & {
  policyReads: string[];
} {
  const byHash = new Map(Object.keys(policies).map((id) => [hashOf(id), id]));
  const policyReads: string[] = [];
  return {
    policyReads,
    lookupLocalContextGraphId: (nameHash) => byHash.get(nameHash) ?? null,
    isPublicContextGraph: async (contextGraphId) => {
      policyReads.push(contextGraphId);
      // A slow chain read holds its policy-read slot until the gate opens.
      if (gate !== undefined) await gate;
      const policy = policies[contextGraphId];
      if (policy === 'unavailable') throw new Error('chain unavailable');
      return policy === 'public';
    },
  };
}

function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

async function ask(
  handler: ReturnType<typeof createContextGraphNameRequestHandler>,
  nameHash: string,
): Promise<ReturnType<typeof decodeContextGraphNameResponse>> {
  return decodeContextGraphNameResponse(await handler(encodeContextGraphNameRequest(nameHash)));
}

describe('context-graph-name wire format', () => {
  it('is versioned by protocol id and message field', () => {
    expect(PROTOCOL_CONTEXT_GRAPH_NAME).toBe('/dkg/10.0.0/context-graph-name/1');
    const bytes = encodeContextGraphNameRequest(hashOf(PUBLIC_ID).toUpperCase().replace('0X', '0x'));
    expect(JSON.parse(decoder.decode(bytes))).toEqual({ version: 1, nameHash: hashOf(PUBLIC_ID) });
  });

  it('decodes requests strictly', () => {
    const valid = { version: 1, nameHash: hashOf(PUBLIC_ID) };
    expect(decodeContextGraphNameRequest(encoder.encode(JSON.stringify(valid)))).toEqual(valid);
    for (const invalid of [
      { ...valid, version: 2 },
      { version: 1 },
      { ...valid, extra: true },
      { version: 1, nameHash: '0x1234' },
      [valid],
      'nope',
    ]) {
      expect(decodeContextGraphNameRequest(encoder.encode(JSON.stringify(invalid)))).toBeNull();
    }
    expect(decodeContextGraphNameRequest(encoder.encode('{not json'))).toBeNull();
    expect(decodeContextGraphNameRequest(new Uint8Array(0))).toBeNull();
    expect(decodeContextGraphNameRequest(
      encoder.encode(JSON.stringify({ ...valid, pad: 'x'.repeat(CONTEXT_GRAPH_NAME_MAX_REQUEST_BYTES) })),
    )).toBeNull();
  });

  it('decodes responses strictly and never trusts unknown shapes', () => {
    const found = { version: 1, status: 'found', contextGraphId: PUBLIC_ID } as const;
    expect(decodeContextGraphNameResponse(encodeContextGraphNameResponse(found))).toEqual(found);
    expect(decodeContextGraphNameResponse(encoder.encode(JSON.stringify({ version: 1, status: 'not-found' }))))
      .toEqual({ version: 1, status: 'not-found' });
    for (const invalid of [
      { version: 2, status: 'found', contextGraphId: PUBLIC_ID },
      { version: 1, status: 'found' },
      { version: 1, status: 'found', contextGraphId: 7 },
      { version: 1, status: 'found', contextGraphId: 'x'.repeat(257) },
      { version: 1, status: 'found', contextGraphId: PUBLIC_ID, hint: 'extra' },
      { version: 1, status: 'maybe' },
      // Only pre-release builds ever sent this; it reads as a miss.
      { version: 1, status: 'busy' },
    ]) {
      expect(decodeContextGraphNameResponse(encoder.encode(JSON.stringify(invalid)))).toBeNull();
    }
  });
});

describe('context-graph-name responder', () => {
  it('reveals the cleartext id of a public graph', async () => {
    const handler = createContextGraphNameRequestHandler(source({ [PUBLIC_ID]: 'public' }));
    expect(await ask(handler, hashOf(PUBLIC_ID)))
      .toEqual({ version: 1, status: 'found', contextGraphId: PUBLIC_ID });
  });

  it('never reveals the cleartext id of a private graph', async () => {
    const reveal = source({ [PRIVATE_ID]: 'private' });
    const handler = createContextGraphNameRequestHandler(reveal);
    expect(await ask(handler, hashOf(PRIVATE_ID))).toEqual({ version: 1, status: 'not-found' });
    expect(reveal.policyReads).toEqual([PRIVATE_ID]);
  });

  it('fails closed when the access policy cannot be read', async () => {
    const handler = createContextGraphNameRequestHandler(source({ [PUBLIC_ID]: 'unavailable' }));
    expect(await ask(handler, hashOf(PUBLIC_ID))).toEqual({ version: 1, status: 'not-found' });
  });

  it('fails closed when the policy read hangs past its budget', async () => {
    const handler = createContextGraphNameRequestHandler({
      lookupLocalContextGraphId: () => PUBLIC_ID,
      isPublicContextGraph: (_id, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    }, { policyReadTimeoutMs: 20 });
    expect(await ask(handler, hashOf(PUBLIC_ID))).toEqual({ version: 1, status: 'not-found' });
  });

  it('answers private, unknown-policy, unknown-graph and overloaded requests identically', async () => {
    const handler = createContextGraphNameRequestHandler(source({
      [PRIVATE_ID]: 'private',
      [PUBLIC_ID]: 'unavailable',
    }));
    const privateAnswer = await handler(encodeContextGraphNameRequest(hashOf(PRIVATE_ID)));
    const unavailableAnswer = await handler(encodeContextGraphNameRequest(hashOf(PUBLIC_ID)));
    const unknownAnswer = await handler(encodeContextGraphNameRequest(hashOf('never-heard-of-it')));
    expect(sameBytes(privateAnswer, unknownAnswer)).toBe(true);
    expect(sameBytes(unavailableAnswer, unknownAnswer)).toBe(true);

    // Load shedding: only requests for a held graph ever reach the
    // policy-read bound, so the overloaded answer must be the same refusal,
    // or a burst of requests for a private graph's chain-known name hash
    // would tell a non-member that this node is a member.
    const slowChain = gate();
    const reveal = source({ [PRIVATE_ID]: 'private', [PUBLIC_ID]: 'public' }, slowChain.opened);
    const saturated = createContextGraphNameRequestHandler(reveal, { maxConcurrentPolicyReads: 1 });
    const holding = saturated(encodeContextGraphNameRequest(hashOf(PRIVATE_ID)));
    const whileSaturated = await Promise.all([PRIVATE_ID, PUBLIC_ID, 'never-heard-of-it'].map(
      (id) => saturated(encodeContextGraphNameRequest(hashOf(id))),
    ));
    for (const answer of whileSaturated) expect(sameBytes(answer, unknownAnswer)).toBe(true);
    // The bound held: the shed requests spent no policy read.
    expect(reveal.policyReads).toEqual([PRIVATE_ID]);
    slowChain.open();
    expect(sameBytes(await holding, unknownAnswer)).toBe(true);
  });

  it('spends no policy read on hashes it does not hold', async () => {
    const reveal = source({ [PUBLIC_ID]: 'public' });
    const handler = createContextGraphNameRequestHandler(reveal);
    for (let index = 0; index < 50; index += 1) {
      expect(await ask(handler, hashOf(`random-${index}`))).toEqual({ version: 1, status: 'not-found' });
    }
    expect(reveal.policyReads).toEqual([]);
  });

  it('reveals only the exact preimage of the requested hash', async () => {
    const reveal: ContextGraphNameRevealSource = {
      // A buggy lookup returning some other graph must not leak it.
      lookupLocalContextGraphId: () => PRIVATE_ID,
      isPublicContextGraph: async () => true,
    };
    const handler = createContextGraphNameRequestHandler(reveal);
    expect(await ask(handler, hashOf(PUBLIC_ID))).toEqual({ version: 1, status: 'not-found' });
  });

  it('fails closed, with the ordinary refusal, when the local lookup throws', async () => {
    let policyReads = 0;
    const handler = createContextGraphNameRequestHandler({
      lookupLocalContextGraphId: () => { throw new Error('subscription table unavailable'); },
      isPublicContextGraph: async () => { policyReads += 1; return true; },
    });
    const answer = await handler(encodeContextGraphNameRequest(hashOf(PUBLIC_ID)));
    const unknownAnswer = await createContextGraphNameRequestHandler(source({}))(
      encodeContextGraphNameRequest(hashOf(PUBLIC_ID)),
    );
    expect(decodeContextGraphNameResponse(answer)).toEqual({ version: 1, status: 'not-found' });
    expect(sameBytes(answer, unknownAnswer)).toBe(true);
    expect(policyReads).toBe(0);
  });

  it('rejects malformed requests without a lookup', async () => {
    let lookups = 0;
    const handler = createContextGraphNameRequestHandler({
      lookupLocalContextGraphId: () => { lookups += 1; return PUBLIC_ID; },
      isPublicContextGraph: async () => true,
    });
    const response = await handler(encoder.encode('{"version":1,"nameHash":"0xdead"}'));
    expect(decodeContextGraphNameResponse(response)).toEqual({ version: 1, status: 'invalid-request' });
    expect(lookups).toBe(0);
  });

  it('bounds concurrent policy reads, shedding the excess with the ordinary refusal', async () => {
    const slowChain = gate();
    const reveal = source({ [PUBLIC_ID]: 'public' }, slowChain.opened);
    const handler = createContextGraphNameRequestHandler(reveal, { maxConcurrentPolicyReads: 2 });
    const first = ask(handler, hashOf(PUBLIC_ID));
    const second = ask(handler, hashOf(PUBLIC_ID));
    expect(await ask(handler, hashOf(PUBLIC_ID))).toEqual({ version: 1, status: 'not-found' });
    expect(reveal.policyReads).toEqual([PUBLIC_ID, PUBLIC_ID]);
    slowChain.open();
    expect(await first).toEqual({ version: 1, status: 'found', contextGraphId: PUBLIC_ID });
    expect(await second).toEqual({ version: 1, status: 'found', contextGraphId: PUBLIC_ID });
    // The slots are released: the next request is served again.
    expect(await ask(handler, hashOf(PUBLIC_ID))).toEqual({ version: 1, status: 'found', contextGraphId: PUBLIC_ID });
  });
});
