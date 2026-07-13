import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  TypedEventBus,
  contextGraphSharedMemoryUri,
  contextGraphWorkspaceMetaGraphUri,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { DKGPublisher, type PublishResult } from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import { KEEP_ROOT_COPY_PREDICATE } from '../src/finalization-handler.js';

const CONTEXT_GRAPH = 'publish-response-barrier';
const ROOT = 'urn:test:publish-response-barrier:root';
const CHILD = `${ROOT}/.well-known/genid/child`;
const SWM_GRAPH = contextGraphSharedMemoryUri(CONTEXT_GRAPH);
const SWM_META_GRAPH = contextGraphWorkspaceMetaGraphUri(CONTEXT_GRAPH);
const WORKSPACE_OWNER_PREDICATE = 'http://dkg.io/ontology/workspaceOwner';

const DATA_CLEANUP = 'publisher.clearPublishedSwmRoots.data';
const METADATA_CLEANUP = 'publisher.clearPublishedSwmRoots.metadata';
const KEEP_ROOT_SIGNAL = 'publish.persistKeepRootCopySignals';
const AUTHORITATIVE_SOURCES = [DATA_CLEANUP, METADATA_CLEANUP, KEEP_ROOT_SIGNAL] as const;
type AuthoritativeSource = (typeof AUTHORITATIVE_SOURCES)[number];

const originalTailGraceMs = process.env.DKG_PUBLISH_TAIL_GRACE_MS;

beforeEach(() => {
  // PR #1590's detached-tail implementation accepted zero here. Keeping the
  // value pinned makes this regression exercise that path in a few event-loop
  // turns instead of waiting for its production grace period.
  process.env.DKG_PUBLISH_TAIL_GRACE_MS = '0';
});

afterEach(() => {
  if (originalTailGraceMs === undefined) {
    delete process.env.DKG_PUBLISH_TAIL_GRACE_MS;
  } else {
    process.env.DKG_PUBLISH_TAIL_GRACE_MS = originalTailGraceMs;
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeMutationGate() {
  return {
    entered: deferred(),
    release: deferred(),
    finished: deferred(),
  };
}

async function advanceTimerTurns(turns = 4): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function writeNewerKeepRootSignal(
  update: (sparql: string) => Promise<void>,
): Promise<void> {
  await update(`DELETE {
  GRAPH <${SWM_META_GRAPH}> { ?root <${KEEP_ROOT_COPY_PREDICATE}> ?previous }
}
INSERT {
  GRAPH <${SWM_META_GRAPH}> { ?root <${KEEP_ROOT_COPY_PREDICATE}> "false" }
}
WHERE {
  VALUES ?root { <${ROOT}> }
  OPTIONAL {
    GRAPH <${SWM_META_GRAPH}> { ?root <${KEEP_ROOT_COPY_PREDICATE}> ?previous }
  }
}`);
}

function confirmedResult(): PublishResult {
  return {
    kaId: 1n,
    ual: 'did:dkg:test/1',
    merkleRoot: new Uint8Array(32),
    kaManifest: [{
      tokenId: 1n,
      rootEntity: ROOT,
      privateTripleCount: 0,
    }],
    status: 'confirmed',
    publicQuads: [],
    onChainResult: {
      batchId: 1n,
      kaId: 1n,
      startKAId: 1n,
      endKAId: 1n,
      txHash: '0xpublish-response-barrier',
      blockNumber: 1,
      txIndex: 0,
      blockTimestamp: 1,
      publisherAddress: '0x1111111111111111111111111111111111111111',
    },
  };
}

async function makeConfirmedPublishFixture() {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain: new NoChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
  publisher.publish = async () => confirmedResult();

  await store.insert([
    {
      subject: ROOT,
      predicate: 'http://schema.org/name',
      object: '"root"',
      graph: SWM_GRAPH,
    },
    {
      subject: CHILD,
      predicate: 'http://schema.org/name',
      object: '"child"',
      graph: SWM_GRAPH,
    },
    {
      subject: ROOT,
      predicate: WORKSPACE_OWNER_PREDICATE,
      object: '"peer-owner"',
      graph: SWM_META_GRAPH,
    },
  ]);

  const warnings: string[] = [];
  const agentLike = {
    store,
    publisher,
    chain: {},
    peerId: 'peer-publish-response-barrier',
    log: {
      info: () => undefined,
      warn: (_ctx: unknown, message: string) => { warnings.push(message); },
      error: () => undefined,
      debug: () => undefined,
    },
    gossip: {
      publish: async () => undefined,
    },
    getContextGraphOnChainId: async () => undefined,
    createV10ACKProvider: () => undefined,
    _resolveEncryptInlinePayload: async () => undefined,
    _resolveEncryptInlineChunked: async () => undefined,
  } as any;

  return { store, publisher, agentLike, warnings };
}

function invokePublicConfirmedPublish(agentLike: any): Promise<PublishResult> {
  return (DKGAgent.prototype as any).publishFromSharedMemory.call(
    agentLike,
    CONTEXT_GRAPH,
    'all',
  );
}

describe('confirmed publish response barrier', () => {
  it('does not resolve before data, metadata, and keep-root mutations finish, or permit late stale writes', async () => {
    const { store, agentLike } = await makeConfirmedPublishFixture();
    const originalUpdate = store.update.bind(store);
    const gates: Record<AuthoritativeSource, ReturnType<typeof makeMutationGate>> = {
      [DATA_CLEANUP]: makeMutationGate(),
      [METADATA_CLEANUP]: makeMutationGate(),
      [KEEP_ROOT_SIGNAL]: makeMutationGate(),
    };
    const enteredOrder: AuthoritativeSource[] = [];
    const completedOrder: AuthoritativeSource[] = [];

    store.update = async (sparql, options) => {
      const source = options?.source;
      const gate = source === DATA_CLEANUP
        || source === METADATA_CLEANUP
        || source === KEEP_ROOT_SIGNAL
        ? gates[source]
        : undefined;
      if (!gate) {
        await originalUpdate(sparql, options);
        return;
      }

      enteredOrder.push(source as AuthoritativeSource);
      gate.entered.resolve();
      await gate.release.promise;
      try {
        await originalUpdate(sparql, options);
      } finally {
        completedOrder.push(source as AuthoritativeSource);
        gate.finished.resolve();
      }
    };

    let responseSettled = false;
    let completionsAtResponse = -1;
    const response = invokePublicConfirmedPublish(agentLike);
    const observedResponse = response.then(
      (result) => {
        responseSettled = true;
        completionsAtResponse = completedOrder.length;
        return { ok: true as const, result };
      },
      (error: unknown) => {
        responseSettled = true;
        completionsAtResponse = completedOrder.length;
        return { ok: false as const, error };
      },
    );

    let newerSignalWritten = false;
    const writeNewerSignalIfResponseEscaped = async () => {
      if (!responseSettled || newerSignalWritten) return;
      newerSignalWritten = true;
      await writeNewerKeepRootSignal(originalUpdate);
    };

    await gates[DATA_CLEANUP].entered.promise;
    await advanceTimerTurns();
    const enteredAtDataBarrier = [...enteredOrder];
    const settledAtDataBarrier = responseSettled;
    await writeNewerSignalIfResponseEscaped();

    gates[DATA_CLEANUP].release.resolve();
    await gates[METADATA_CLEANUP].entered.promise;
    await advanceTimerTurns();
    const enteredAtMetadataBarrier = [...enteredOrder];
    const settledAtMetadataBarrier = responseSettled;
    await writeNewerSignalIfResponseEscaped();

    gates[METADATA_CLEANUP].release.resolve();
    await gates[KEEP_ROOT_SIGNAL].entered.promise;
    await advanceTimerTurns();
    const enteredAtKeepRootBarrier = [...enteredOrder];
    const settledAtKeepRootBarrier = responseSettled;
    await writeNewerSignalIfResponseEscaped();

    gates[KEEP_ROOT_SIGNAL].release.resolve();
    await Promise.all(AUTHORITATIVE_SOURCES.map((source) => gates[source].finished.promise));
    const observed = await observedResponse;
    if (!observed.ok) throw observed.error;

    if (!newerSignalWritten) {
      newerSignalWritten = true;
      await writeNewerKeepRootSignal(originalUpdate);
    }

    const completionsAfterResponse = completedOrder.length;
    await advanceTimerTurns();

    expect(settledAtDataBarrier).toBe(false);
    expect(settledAtMetadataBarrier).toBe(false);
    expect(settledAtKeepRootBarrier).toBe(false);
    expect(enteredAtDataBarrier).toEqual([DATA_CLEANUP]);
    expect(enteredAtMetadataBarrier).toEqual([DATA_CLEANUP, METADATA_CLEANUP]);
    expect(enteredAtKeepRootBarrier).toEqual(AUTHORITATIVE_SOURCES);
    expect(enteredOrder).toEqual(AUTHORITATIVE_SOURCES);
    expect(completedOrder).toEqual(AUTHORITATIVE_SOURCES);
    expect(completionsAtResponse).toBe(AUTHORITATIVE_SOURCES.length);
    expect(completedOrder).toHaveLength(completionsAfterResponse);
    expect(observed.result).toMatchObject({ status: 'confirmed', ual: 'did:dkg:test/1' });

    await expect(store.query(`ASK {
      GRAPH <${SWM_GRAPH}> {
        VALUES ?subject { <${ROOT}> <${CHILD}> }
        ?subject ?predicate ?object
      }
    }`)).resolves.toEqual({ type: 'boolean', value: false });
    await expect(store.query(`ASK {
      GRAPH <${SWM_META_GRAPH}> {
        <${ROOT}> <${WORKSPACE_OWNER_PREDICATE}> ?owner
      }
    }`)).resolves.toEqual({ type: 'boolean', value: false });

    const keepRootSignal = await store.query(`SELECT ?value WHERE {
      GRAPH <${SWM_META_GRAPH}> {
        <${ROOT}> <${KEEP_ROOT_COPY_PREDICATE}> ?value
      }
    }`);
    expect(keepRootSignal.type).toBe('bindings');
    if (keepRootSignal.type === 'bindings') {
      expect(keepRootSignal.bindings).toEqual([{ value: '"false"' }]);
    }
  });

  it.each([
    [DATA_CLEANUP, [DATA_CLEANUP]],
    [METADATA_CLEANUP, [DATA_CLEANUP, METADATA_CLEANUP]],
  ] as const)('propagates a %s failure before later authoritative writes start', async (
    failingSource,
    expectedSources,
  ) => {
    const { store, agentLike } = await makeConfirmedPublishFixture();
    const originalUpdate = store.update.bind(store);
    const seenSources: string[] = [];
    store.update = async (sparql, options) => {
      if (options?.source) seenSources.push(options.source);
      if (options?.source === failingSource) {
        throw new Error(`injected ${failingSource} failure`);
      }
      await originalUpdate(sparql, options);
    };

    await expect(invokePublicConfirmedPublish(agentLike)).rejects.toThrow(
      `injected ${failingSource} failure`,
    );
    const sourcesAtRejection = [...seenSources];
    await advanceTimerTurns();

    expect(sourcesAtRejection).toEqual(expectedSources);
    expect(seenSources).toEqual(expectedSources);
    expect(seenSources).not.toContain(KEEP_ROOT_SIGNAL);
  });

  it('waits for a failed keep-root mutation before returning the confirmed result', async () => {
    const { store, agentLike, warnings } = await makeConfirmedPublishFixture();
    const originalUpdate = store.update.bind(store);
    const keepRootEntered = deferred();
    const releaseKeepRoot = deferred();
    const seenSources: string[] = [];
    store.update = async (sparql, options) => {
      if (options?.source) seenSources.push(options.source);
      if (options?.source === KEEP_ROOT_SIGNAL) {
        keepRootEntered.resolve();
        await releaseKeepRoot.promise;
        throw new Error('injected keep-root failure');
      }
      await originalUpdate(sparql, options);
    };

    let responseSettled = false;
    const response = invokePublicConfirmedPublish(agentLike).then((result) => {
      responseSettled = true;
      return result;
    });

    await keepRootEntered.promise;
    await advanceTimerTurns();
    const settledBeforeFailedMutationFinished = responseSettled;
    releaseKeepRoot.resolve();
    const result = await response;
    const sourcesAtResponse = [...seenSources];
    await advanceTimerTurns();

    expect(settledBeforeFailedMutationFinished).toBe(false);
    expect(result.status).toBe('confirmed');
    expect(sourcesAtResponse).toEqual(AUTHORITATIVE_SOURCES);
    expect(seenSources).toEqual(AUTHORITATIVE_SOURCES);
    expect(warnings).toContainEqual(expect.stringContaining('injected keep-root failure'));
  });
});
