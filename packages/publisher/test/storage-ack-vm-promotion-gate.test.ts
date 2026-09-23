import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  STORAGE_ACK_DECLINE_CODES,
  TypedEventBus,
  computeCatalogRoot,
  contextGraphCatalogUri,
  contextGraphMetaUri,
  createGraphKnowledgeAssetScope,
  decodeStorageACK,
  encodePublishIntent,
  encodeUpdateIntent,
  isStorageACKDecline,
  isTransientStorageACKDeclineCode,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  StorageACKHandler,
  type StorageACKHandlerConfig,
  type StorageAckVmPromotionRequest,
  type StorageAckVmPromotionVerdict,
} from '../src/storage-ack-handler.js';
import { tryResolveKnowledgeAssetWorkspaceHead } from '../src/workspace-resolution.js';
import { computeFlatKCMerkleLeafCountV10, computeFlatKCRootV10 } from '../src/merkle.js';
import {
  STORAGE_ACK_LEDGER_GRAPH,
  STORAGE_ACK_LEDGER_PREDICATES as LEDGER,
  storageAckLedgerMarkUpdate,
} from '../src/storage-ack-ledger.js';

const CG_ID = '42';
const SWM_GRAPH_ID = 'public-source-cg';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const UAL = `did:dkg:otp:20430/${AUTHOR}/7`;
const KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
const PEER = { toString: () => 'publisher-peer' };
const OK: StorageAckVmPromotionVerdict = { ok: true };

function layerGraph(layer: MemoryLayer, version: number): string {
  return knowledgeAssetLayerGraphUri(
    SWM_GRAPH_ID,
    layer,
    createGraphKnowledgeAssetScope(UAL, version),
  );
}

function assetQuads(value: string, graph: string): Quad[] {
  return [{ subject: 'urn:asset:gated', predicate: 'urn:p:value', object: `"${value}"`, graph }];
}

function byteSizeFloor(quads: readonly Quad[]): number {
  return quads.reduce(
    (sum, quad) => sum
      + Buffer.byteLength(quad.subject, 'utf8')
      + Buffer.byteLength(quad.predicate, 'utf8')
      + Buffer.byteLength(quad.object, 'utf8'),
    0,
  );
}

function wireNquads(quads: readonly Quad[]): Uint8Array {
  return new TextEncoder().encode(quads.map((quad) =>
    `<${quad.subject}> <${quad.predicate}> ${quad.object} <${quad.graph}> .`,
  ).join('\n'));
}

interface Harness {
  wallet: ethers.Wallet;
  store: OxigraphStore;
  handler: StorageACKHandler;
  signMessage: ReturnType<typeof vi.spyOn>;
  declines: Array<{ code: string; message: string }>;
  priorVersions: Array<Record<string, string>>;
}

function harness(
  gate: StorageACKHandlerConfig['ensureVmPromotion'],
  options: {
    curated?: boolean;
    store?: OxigraphStore;
    rootCount?: (kaUal: string) => Promise<bigint>;
    locks?: Map<string, Promise<void>>;
  } = {},
): Harness {
  const store = options.store ?? new OxigraphStore();
  const wallet = ethers.Wallet.createRandom();
  const signMessage = vi.spyOn(wallet, 'signMessage');
  const declines: Array<{ code: string; message: string }> = [];
  const priorVersions: Array<Record<string, string>> = [];
  const handler = new StorageACKHandler(store, {
    nodeRole: 'core',
    nodeIdentityId: 17n,
    signerWallet: wallet,
    contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
    chainId: 31337n,
    kav10Address: '0x000000000000000000000000000000000000c10a',
    isCgCurated: async () => options.curated === true,
    ensureVmPromotion: gate,
    onDecline: (details) => { declines.push(details); },
    onPriorVersionAwaitingPromotion: (request) => { priorVersions.push({ ...request }); },
    ...(options.rootCount ? { readKnowledgeAssetRootCount: options.rootCount } : {}),
    ...(options.locks ? { workspaceWriteLocks: options.locks } : {}),
  }, new TypedEventBus());
  return { wallet, store, handler, signMessage, declines, priorVersions };
}

/** A graph-scoped public publish, inline (`value`) or from local SWM (`inline: false`). */
function publishIntent(
  value: string,
  options: { inline?: boolean; version?: number; graphScoped?: boolean } = {},
): { bytes: Uint8Array; quads: Quad[] } {
  const version = options.version ?? 1;
  const quads = assetQuads(value, layerGraph(MemoryLayer.SharedWorkingMemory, version));
  const graphScoped = options.graphScoped ?? true;
  return {
    quads,
    bytes: encodePublishIntent({
      merkleRoot: computeFlatKCRootV10([...quads], []),
      contextGraphId: CG_ID,
      swmGraphId: SWM_GRAPH_ID,
      publisherPeerId: 'publisher-peer',
      publicByteSize: options.inline === false ? byteSizeFloor(quads) : wireNquads(quads).length,
      isPrivate: false,
      kaCount: 1,
      rootEntities: graphScoped ? [] : ['urn:asset:gated'],
      merkleLeafCount: computeFlatKCMerkleLeafCountV10([...quads], []),
      ...(options.inline === false ? {} : { stagingQuads: wireNquads(quads) }),
      ...(graphScoped
        ? {
          contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
          kaUal: UAL,
          assertionVersion: String(version),
          publicTripleCount: quads.length,
          privateTripleCount: 0,
          accessPolicy: 'public' as const,
          allowedPeers: [],
        }
        : {}),
    }),
  };
}

/** The default public update: graph-scoped, payload inline from the publisher's VM graph. */
function updateIntent(
  value: string,
  options: { version?: number; graphScoped?: boolean; inline?: boolean } = {},
): { bytes: Uint8Array; quads: Quad[] } {
  const version = options.version ?? 2;
  const graphScoped = options.graphScoped ?? true;
  const inline = options.inline ?? true;
  const quads = assetQuads(
    value,
    graphScoped
      ? layerGraph(inline ? MemoryLayer.VerifiableMemory : MemoryLayer.SharedWorkingMemory, version)
      : `did:dkg:context-graph:${SWM_GRAPH_ID}/_shared_memory`,
  );
  return {
    quads,
    bytes: encodeUpdateIntent({
      kaId: KA_ID.toString(),
      contextGraphId: CG_ID,
      swmGraphId: SWM_GRAPH_ID,
      preUpdateMerkleRootCount: version - 1,
      newMerkleRoot: computeFlatKCRootV10([...quads], []),
      newByteSize: inline ? wireNquads(quads).length : byteSizeFloor(quads),
      newTokenAmount: '1000',
      mintAmount: 0,
      burnTokenIds: [],
      newMerkleLeafCount: computeFlatKCMerkleLeafCountV10([...quads], []),
      publisherPeerId: 'publisher-peer',
      ...(inline ? { stagingQuads: wireNquads(quads) } : {}),
      ...(graphScoped
        ? {
          contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
          kaUal: UAL,
          assertionVersion: String(version),
          publicTripleCount: quads.length,
          privateTripleCount: 0,
        }
        : {}),
    }),
  };
}

async function head(store: OxigraphStore) {
  const resolution = await tryResolveKnowledgeAssetWorkspaceHead({
    store,
    graphManager: new GraphManager(store),
    contextGraphId: SWM_GRAPH_ID,
    kaUal: UAL,
  });
  return resolution.status === 'resolved' ? resolution.head : undefined;
}

async function ledgerRows(store: OxigraphStore): Promise<Array<Record<string, string>>> {
  const result = await store.query(`SELECT ?op ?namespace ?target ?version ?operation WHERE {
    GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> {
      ?op <${LEDGER.namespace}> ?namespace ;
        <${LEDGER.contextGraphId}> ?target ;
        <${LEDGER.assertionVersion}> ?version ;
        <${LEDGER.operation}> ?operation .
    }
  } ORDER BY ?version`);
  return result.type === 'bindings' ? result.bindings as Array<Record<string, string>> : [];
}

async function supersededRows(store: OxigraphStore): Promise<string[]> {
  const result = await store.query(`SELECT ?op WHERE { GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> {
    ?op <${LEDGER.supersededAt}> ?at
  } }`);
  return result.type === 'bindings' ? result.bindings.map((row) => row['op']!) : [];
}

async function swmValues(store: OxigraphStore): Promise<string[]> {
  const result = await store.query(
    `SELECT ?o WHERE { GRAPH <${layerGraph(MemoryLayer.SharedWorkingMemory, 1)}> { ?s ?p ?o } }`,
  );
  return result.type === 'bindings' ? result.bindings.map((row) => row['o']!) : [];
}

async function markPromoted(store: OxigraphStore, version: number): Promise<void> {
  await store.deleteByPattern({ graph: contextGraphMetaUri(SWM_GRAPH_ID), subject: UAL });
  await store.insert([
    { subject: UAL, predicate: 'http://dkg.io/ontology/status', object: '"confirmed"', graph: contextGraphMetaUri(SWM_GRAPH_ID) },
    {
      subject: UAL,
      predicate: 'http://dkg.io/ontology/assertionVersion',
      object: `"${version}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
      graph: contextGraphMetaUri(SWM_GRAPH_ID),
    },
  ]);
}

async function signedPublish(h: Harness, value = 'v1'): Promise<void> {
  const ack = decodeStorageACK(await h.handler.handler(publishIntent(value).bytes, PEER));
  expect(isStorageACKDecline(ack)).toBe(false);
}

describe('StorageACK VM-promotion finality gate', () => {
  it('asks the gate first, then keeps the copy and its ledger row, and only then signs', async () => {
    const requests: StorageAckVmPromotionRequest[] = [];
    let stateAtGate: { head: unknown; ledger: number } | undefined;
    let ledgerAtSign = -1;
    const h = harness(async (request) => {
      requests.push(request);
      stateAtGate = { head: await head(h.store), ledger: (await ledgerRows(h.store)).length };
      return OK;
    });
    h.signMessage.mockImplementation(async (message: string | Uint8Array) => {
      ledgerAtSign = (await ledgerRows(h.store)).length;
      return ethers.Wallet.prototype.signMessage.call(h.wallet, message);
    });

    const ack = decodeStorageACK(await h.handler.handler(publishIntent('v1').bytes, PEER));

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(requests).toEqual([
      expect.objectContaining({ contextGraphId: CG_ID, swmGraphId: SWM_GRAPH_ID, operation: 'publish' }),
    ]);
    // Nothing is written for a request the gate may still refuse.
    expect(stateAtGate).toEqual({ head: undefined, ledger: 0 });
    expect(ledgerAtSign).toBe(1);
    expect(await head(h.store)).toMatchObject({ kaUal: UAL, assertionVersion: '1' });
    expect(await h.store.countQuads(layerGraph(MemoryLayer.SharedWorkingMemory, 1))).toBe(1);
    expect(await ledgerRows(h.store)).toEqual([expect.objectContaining({
      namespace: `"${SWM_GRAPH_ID}"`,
      target: `"${CG_ID}"`,
      operation: '"publish"',
    })]);
  });

  it('ledgers an ACK signed over a copy already in local SWM', async () => {
    const h = harness(async () => OK);
    const { bytes, quads } = publishIntent('v1', { inline: false });
    await h.store.insert(quads);

    const ack = decodeStorageACK(await h.handler.handler(bytes, PEER));

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(await head(h.store)).toMatchObject({ kaUal: UAL });
    expect(await ledgerRows(h.store)).toHaveLength(1);
  });

  it('sends a transient refusal as CORE_TEMPORARILY_UNAVAILABLE, labelled locally, and keeps nothing', async () => {
    const h = harness(async () => ({
      ok: false,
      code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE,
      message: 'VM reconciliation is not running on this core yet',
    }));

    const ack = decodeStorageACK(await h.handler.handler(publishIntent('v1').bytes, PEER));

    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
    expect(ack.declineMessage).toBe('VM promotion unavailable: VM reconciliation is not running on this core yet');
    expect(isTransientStorageACKDeclineCode(ack.declineCode)).toBe(true);
    expect(h.declines).toEqual([expect.objectContaining({
      code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE,
    })]);
    expect(h.signMessage).not.toHaveBeenCalled();
    expect(await head(h.store)).toBeUndefined();
    expect(await h.store.countQuads(layerGraph(MemoryLayer.SharedWorkingMemory, 1))).toBe(0);
    expect(await ledgerRows(h.store)).toHaveLength(0);
  });

  it('sends CORE_VM_PROMOTION_DISABLED as a final refusal and keeps nothing', async () => {
    const h = harness(async () => ({
      ok: false,
      code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED,
      message: 'VM reconciliation is disabled on this core',
    }));

    const ack = decodeStorageACK(await h.handler.handler(publishIntent('v1').bytes, PEER));

    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED);
    expect(ack.declineMessage).toBe('VM reconciliation is disabled on this core');
    expect(isTransientStorageACKDeclineCode(ack.declineCode)).toBe(false);
    expect(h.signMessage).not.toHaveBeenCalled();
    expect(await head(h.store)).toBeUndefined();
    expect(await ledgerRows(h.store)).toHaveLength(0);
  });

  it('treats a throwing gate as a transient refusal and keeps the local error off the wire', async () => {
    const h = harness(async () => {
      throw new Error('subscription store unavailable');
    });

    const ack = decodeStorageACK(await h.handler.handler(publishIntent('v1').bytes, PEER));

    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
    expect(ack.declineMessage).not.toContain('subscription store');
    expect(h.declines[0]?.message).toContain('subscription store');
    expect(h.signMessage).not.toHaveBeenCalled();
  });

  it('refuses a legacy (not graph-scoped) public publish on a gated core', async () => {
    const gate = vi.fn(async () => OK);
    const h = harness(gate);

    const ack = decodeStorageACK(await h.handler.handler(
      publishIntent('legacy', { graphScoped: false }).bytes,
      PEER,
    ));

    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED);
    expect(ack.declineMessage).toContain('legacy');
    expect(h.signMessage).not.toHaveBeenCalled();
    expect(await ledgerRows(h.store)).toHaveLength(0);
  });

  describe('conflicting ACK copies', () => {
    it('re-signs the same content idempotently', async () => {
      const h = harness(async () => OK);
      await signedPublish(h, 'v1');

      const again = decodeStorageACK(await h.handler.handler(publishIntent('v1').bytes, PEER));

      expect(isStorageACKDecline(again)).toBe(false);
      expect(await ledgerRows(h.store)).toHaveLength(1);
    });

    it('refuses different content at a version this core already holds, keeping the first copy', async () => {
      const h = harness(async () => OK);
      await signedPublish(h, 'v1');

      const conflicting = decodeStorageACK(await h.handler.handler(publishIntent('other').bytes, PEER));

      expect(conflicting.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CONFLICTING_KA_ASSERTION);
      expect(isTransientStorageACKDeclineCode(conflicting.declineCode)).toBe(false);
      const kept = await h.store.query(
        `SELECT ?o WHERE { GRAPH <${layerGraph(MemoryLayer.SharedWorkingMemory, 1)}> { ?s ?p ?o } }`,
      );
      expect(kept.type === 'bindings' ? kept.bindings.map((row) => row['o']) : []).toEqual(['"v1"']);
      expect(h.signMessage).toHaveBeenCalledOnce();
    });

    it('refuses an older version than the one this core holds', async () => {
      const h = harness(async () => OK);
      await signedPublish(h, 'v1');
      await markPromoted(h.store, 1);
      const update = decodeStorageACK(await h.handler.updateHandler(updateIntent('v2').bytes, PEER));
      expect(isStorageACKDecline(update)).toBe(false);

      const stale = decodeStorageACK(await h.handler.handler(publishIntent('v1').bytes, PEER));

      expect(stale.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CONFLICTING_KA_ASSERTION);
      expect(await head(h.store)).toMatchObject({ assertionVersion: '2' });
    });
  });

  describe('held copies the core no longer owes', () => {
    it('declines a same-version retry while the held copy may still land on chain', async () => {
      // Not on chain yet (count < version) is not proof it never lands: its
      // transaction may be pending.
      const h = harness(async () => OK, { rootCount: async () => 0n });
      await signedPublish(h, 'first-attempt');

      const retry = decodeStorageACK(await h.handler.handler(publishIntent('edited-retry').bytes, PEER));

      expect(retry.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
      expect(retry.declineMessage).toContain('may still land');
      expect(await swmValues(h.store)).toEqual(['"first-attempt"']);
      expect(await supersededRows(h.store)).toEqual([]);
    });

    it.each([
      { label: 'older than the pending-transaction window', mark: LEDGER.signedAt, at: () => new Date(Date.now() - 6 * 60_000) },
      { label: 'seen absent on chain by the audit', mark: LEDGER.absentSeenAt, at: () => new Date() },
    ])('replaces a same-version copy it signed once it is $label', async ({ mark, at }) => {
      const h = harness(async () => OK, { rootCount: async () => 0n });
      await signedPublish(h, 'first-attempt');
      const [firstRow] = await ledgerRows(h.store);
      await h.store.update!(storageAckLedgerMarkUpdate(firstRow!['op']!, mark, at()));

      const retry = decodeStorageACK(await h.handler.handler(publishIntent('edited-retry').bytes, PEER));

      expect(isStorageACKDecline(retry)).toBe(false);
      expect(await swmValues(h.store)).toEqual(['"edited-retry"']);
      expect(await supersededRows(h.store)).toEqual([firstRow!['op']]);
    });

    it('still refuses different content once that version landed on chain', async () => {
      const h = harness(async () => OK, { rootCount: async () => 1n });
      await signedPublish(h, 'landed');

      const other = decodeStorageACK(await h.handler.handler(publishIntent('too-late').bytes, PEER));

      expect(other.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CONFLICTING_KA_ASSERTION);
      expect(await swmValues(h.store)).toEqual(['"landed"']);
    });

    it('declines transiently when it cannot read the chain version', async () => {
      const h = harness(async () => OK, {
        rootCount: async () => { throw new Error('rpc down'); },
      });
      await signedPublish(h, 'first-attempt');

      const retry = decodeStorageACK(await h.handler.handler(publishIntent('edited-retry').bytes, PEER));

      expect(retry.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
      expect(await swmValues(h.store)).toEqual(['"first-attempt"']);
    });

    it('always replaces a head it never signed', async () => {
      // A copy written without a signature here (an ungated write, standing
      // in for a synced or gossiped copy) has no ledger row.
      const unsigned = harness(undefined);
      const first = decodeStorageACK(await unsigned.handler.handler(publishIntent('not-signed-here').bytes, PEER));
      expect(isStorageACKDecline(first)).toBe(false);
      expect(await ledgerRows(unsigned.store)).toHaveLength(0);
      const h = harness(async () => OK, { store: unsigned.store });

      const ack = decodeStorageACK(await h.handler.handler(publishIntent('acked').bytes, PEER));

      expect(isStorageACKDecline(ack)).toBe(false);
      expect(await swmValues(h.store)).toEqual(['"acked"']);
    });

    it('replaces a held version the chain has already moved past, without waiting for it', async () => {
      const h = harness(async () => OK, { rootCount: async () => 2n });
      await signedPublish(h, 'v1');

      // v2 landed through other cores; this core is asked for v3.
      const ack = decodeStorageACK(await h.handler.updateHandler(updateIntent('v3', { version: 3 }).bytes, PEER));

      expect(isStorageACKDecline(ack)).toBe(false);
      expect(h.priorVersions).toEqual([]);
      expect(await head(h.store)).toMatchObject({ assertionVersion: '3' });
      expect(await supersededRows(h.store)).toHaveLength(1);
    });

    it('replaces a held version the chain has moved past for the next version too', async () => {
      // A later version landed without this core; a +1 request against the
      // held copy releases it instead of waiting on a promotion that fails.
      const h = harness(async () => OK, { rootCount: async () => 2n });
      await signedPublish(h, 'v1');

      const ack = decodeStorageACK(await h.handler.updateHandler(updateIntent('v2-other').bytes, PEER));

      expect(isStorageACKDecline(ack)).toBe(false);
      expect(h.priorVersions).toEqual([]);
      expect(await supersededRows(h.store)).toHaveLength(1);
    });

    it('still waits for a held version that is the chain\'s latest', async () => {
      const h = harness(async () => OK, { rootCount: async () => 1n });
      await signedPublish(h, 'v1');

      const ack = decodeStorageACK(await h.handler.updateHandler(updateIntent('v3', { version: 3 }).bytes, PEER));

      expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
      expect(h.priorVersions).toHaveLength(1);
      expect(await supersededRows(h.store)).toEqual([]);
    });
  });

  it('records a signed copy as owed before the next request for the asset takes the lock', async () => {
    const locks = new Map<string, Promise<void>>();
    const h = harness(async () => OK, { rootCount: async () => 0n, locks });
    // Hold the first request's ledger write open.
    let ledgerWriteStarted!: () => void;
    const started = new Promise<void>((resolve) => { ledgerWriteStarted = resolve; });
    let releaseLedgerWrite!: () => void;
    const released = new Promise<void>((resolve) => { releaseLedgerWrite = resolve; });
    const update = h.store.update!.bind(h.store);
    let held = false;
    h.store.update = (async (sparql: string, options?: { source?: string }) => {
      if (!held && options?.source === 'storage-ack.ledger.record') {
        held = true;
        ledgerWriteStarted();
        await released;
      }
      return update(sparql, options as never);
    }) as typeof h.store.update;

    const first = h.handler.handler(publishIntent('first').bytes, PEER);
    await started;
    const second = h.handler.handler(publishIntent('concurrent-other').bytes, PEER);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseLedgerWrite();

    expect(isStorageACKDecline(decodeStorageACK(await first))).toBe(false);
    const other = decodeStorageACK(await second);
    expect(other.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
    expect(await swmValues(h.store)).toEqual(['"first"']);
    expect(await supersededRows(h.store)).toEqual([]);
  });

  it('keeps registeredAt and refreshes signedAt when the same copy is signed again', async () => {
    const h = harness(async () => OK);
    await signedPublish(h, 'v1');
    const [row] = await ledgerRows(h.store);
    const op = row!['op']!;
    const registeredAt = new Date(Date.now() - 60_000);
    await h.store.update!(storageAckLedgerMarkUpdate(op, LEDGER.registeredAt, registeredAt));
    await h.store.update!(storageAckLedgerMarkUpdate(op, LEDGER.signedAt, new Date(Date.now() - 120_000)));

    await signedPublish(h, 'v1');

    const values = await h.store.query(`SELECT ?p ?o WHERE { GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> { <${op}> ?p ?o } }`);
    const rows = values.type === 'bindings' ? values.bindings : [];
    const registered = rows.filter((r) => r['p'] === LEDGER.registeredAt).map((r) => r['o']);
    const signed = rows.filter((r) => r['p'] === LEDGER.signedAt).map((r) => Date.parse(r['o']!.slice(1, r['o']!.indexOf('"', 1))));
    expect(registered).toHaveLength(1);
    expect(registered[0]).toContain(registeredAt.toISOString());
    expect(signed).toHaveLength(1);
    expect(Date.now() - signed[0]!).toBeLessThan(60_000);
  });

  it('reads the head in the reserved ACK lane under the ACK deadline', async () => {
    const h = harness(async () => OK);
    const seen: Array<{ priority?: string; signal?: AbortSignal }> = [];
    const query = h.store.query.bind(h.store);
    h.store.query = (async (sparql: string, options?: { source?: string; priority?: string; signal?: AbortSignal }) => {
      if (options?.source === 'storage-ack.persistGraphScoped.headCheck') seen.push(options);
      return query(sparql, options as never);
    }) as typeof h.store.query;

    await signedPublish(h, 'v1');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ priority: 'ack' });
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('records the sub-graph of a sub-graph copy in its ledger row', async () => {
    const h = harness(async () => OK);
    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const quads = [{
      subject: 'urn:asset:gated',
      predicate: 'urn:p:value',
      object: '"in-sub-graph"',
      graph: knowledgeAssetLayerGraphUri(SWM_GRAPH_ID, MemoryLayer.SharedWorkingMemory, scope, 'research'),
    }];
    const bytes = new TextEncoder().encode(
      quads.map((q) => `<${q.subject}> <${q.predicate}> ${q.object} <${q.graph}> .`).join('\n'),
    );

    const ack = decodeStorageACK(await h.handler.handler(encodePublishIntent({
      merkleRoot: computeFlatKCRootV10(quads, []),
      contextGraphId: CG_ID,
      swmGraphId: SWM_GRAPH_ID,
      subGraphName: 'research',
      publisherPeerId: 'publisher-peer',
      publicByteSize: bytes.length,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
      stagingQuads: bytes,
      merkleLeafCount: computeFlatKCMerkleLeafCountV10(quads, []),
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: '1',
      publicTripleCount: 1,
      privateTripleCount: 0,
      accessPolicy: 'public',
      allowedPeers: [],
    }), PEER));

    expect(isStorageACKDecline(ack)).toBe(false);
    const row = await h.store.query(`ASK { GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> {
      ?op <${LEDGER.subGraphName}> "research"
    } }`);
    expect(row).toMatchObject({ type: 'boolean', value: true });
  });

  describe('public updates', () => {
    it('keeps the default inline update as a durable versioned copy with a ledger row, then signs', async () => {
      const requests: StorageAckVmPromotionRequest[] = [];
      const h = harness(async (request) => {
        requests.push(request);
        return OK;
      });
      await signedPublish(h, 'v1');
      await markPromoted(h.store, 1);

      const ack = decodeStorageACK(await h.handler.updateHandler(updateIntent('v2').bytes, PEER));

      expect(isStorageACKDecline(ack)).toBe(false);
      expect(requests.map((request) => request.operation)).toEqual(['publish', 'update']);
      expect(await head(h.store)).toMatchObject({ kaUal: UAL, assertionVersion: '2' });
      const copy = await h.store.query(
        `SELECT ?o WHERE { GRAPH <${layerGraph(MemoryLayer.SharedWorkingMemory, 2)}> { ?s ?p ?o } }`,
      );
      expect(copy.type === 'bindings' ? copy.bindings.map((row) => row['o']) : []).toEqual(['"v2"']);
      expect(await ledgerRows(h.store)).toEqual([
        expect.objectContaining({ operation: '"publish"' }),
        expect.objectContaining({ operation: '"update"', target: `"${CG_ID}"` }),
      ]);
    });

    it('declines transiently while the version it would replace is not in VM yet', async () => {
      const h = harness(async () => OK);
      await signedPublish(h, 'v1');

      const ack = decodeStorageACK(await h.handler.updateHandler(updateIntent('v2').bytes, PEER));

      expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
      expect(ack.declineMessage).toContain('awaiting promotion');
      // The embedding is asked to promote the version the update waits on.
      expect(h.priorVersions).toEqual([{
        contextGraphId: CG_ID,
        swmGraphId: SWM_GRAPH_ID,
        kaUal: UAL,
        assertionVersion: '1',
      }]);
      expect(h.declines.at(-1)?.code).toBe(STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE);
      expect(await head(h.store)).toMatchObject({ assertionVersion: '1' });
      expect(await ledgerRows(h.store)).toHaveLength(1);
      expect(h.signMessage).toHaveBeenCalledOnce();
    });

    it('gates an update with the gate verdict and keeps nothing on a refusal', async () => {
      const requests: StorageAckVmPromotionRequest[] = [];
      const h = harness(async (request) => {
        requests.push(request);
        return {
          ok: false,
          code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED,
          message: 'VM reconciliation is disabled on this core',
        };
      });

      const ack = decodeStorageACK(await h.handler.updateHandler(updateIntent('v2').bytes, PEER));

      expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED);
      expect(requests).toEqual([
        expect.objectContaining({ contextGraphId: CG_ID, swmGraphId: SWM_GRAPH_ID, operation: 'update' }),
      ]);
      expect(h.signMessage).not.toHaveBeenCalled();
      expect(await head(h.store)).toBeUndefined();
      expect(await ledgerRows(h.store)).toHaveLength(0);
    });

    it('refuses a legacy (not graph-scoped) public update on a gated core', async () => {
      const h = harness(async () => OK);

      const ack = decodeStorageACK(await h.handler.updateHandler(
        updateIntent('legacy', { graphScoped: false }).bytes,
        PEER,
      ));

      expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED);
      expect(ack.declineMessage).toContain('legacy');
      expect(h.signMessage).not.toHaveBeenCalled();
    });

    it('does not consult the gate for a curated update, whose guarantee is the persisted catalog', async () => {
      const gate = vi.fn(async (): Promise<StorageAckVmPromotionVerdict> => ({
        ok: false,
        code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED,
        message: 'must not be asked',
      }));
      const h = harness(gate, { curated: true });
      const cgDid = `did:dkg:context-graph:${CG_ID}`;
      const catalogTriples = [
        { subject: cgDid, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://www.w3.org/ns/dcat#Dataset' },
        { subject: cgDid, predicate: 'http://purl.org/dc/terms/identifier', object: `"${cgDid}"` },
      ];
      const catalog = computeCatalogRoot(catalogTriples);
      const catalogBytes = new TextEncoder().encode(catalogTriples
        .map((t) => `<${t.subject}> <${t.predicate}> ${t.object.startsWith('"') ? t.object : `<${t.object}>`} .`)
        .join('\n'));

      const ack = decodeStorageACK(await h.handler.updateHandler(encodeUpdateIntent({
        kaId: KA_ID.toString(),
        contextGraphId: CG_ID,
        preUpdateMerkleRootCount: 1,
        newMerkleRoot: ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('curated-update-root'))),
        newByteSize: catalogBytes.length,
        newTokenAmount: '1000',
        mintAmount: 0,
        burnTokenIds: [],
        newMerkleLeafCount: 1,
        publisherPeerId: 'curator',
        stagingQuads: catalogBytes,
        isEncryptedPayload: true,
        newCatalogRoot: catalog.root,
        newCatalogLeafCount: catalog.leafCount,
      }), PEER));

      expect(isStorageACKDecline(ack)).toBe(false);
      expect(gate).not.toHaveBeenCalled();
      expect(await h.store.countQuads(contextGraphCatalogUri(CG_ID))).toBe(catalogTriples.length);
      expect(await ledgerRows(h.store)).toHaveLength(0);
    });
  });

  it('does not consult the gate for a curated publish, whose guarantee is the persisted catalog', async () => {
    const gate = vi.fn(async (): Promise<StorageAckVmPromotionVerdict> => ({
      ok: false,
      code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED,
      message: 'must not be asked',
    }));
    const h = harness(gate, { curated: true });
    const catalogTriples = [{
      subject: `did:dkg:context-graph:${CG_ID}`,
      predicate: 'http://purl.org/dc/terms/identifier',
      object: `"did:dkg:context-graph:${CG_ID}"`,
    }];
    const catalog = computeCatalogRoot(catalogTriples);
    const stagingQuads = new TextEncoder().encode(
      catalogTriples.map((quad) => `<${quad.subject}> <${quad.predicate}> ${quad.object} .`).join('\n'),
    );

    const ack = decodeStorageACK(await h.handler.handler(encodePublishIntent({
      merkleRoot: ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('curated-root'))),
      contextGraphId: CG_ID,
      publisherPeerId: 'publisher-peer',
      publicByteSize: stagingQuads.length,
      isPrivate: true,
      kaCount: 1,
      rootEntities: [],
      stagingQuads,
      merkleLeafCount: 0,
      isEncryptedPayload: true,
      catalogRoot: catalog.root,
      catalogLeafCount: catalog.leafCount,
    }), PEER));

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(h.signMessage).toHaveBeenCalledOnce();
    expect(gate).not.toHaveBeenCalled();
    expect(await h.store.countQuads(contextGraphCatalogUri(CG_ID))).toBe(catalogTriples.length);
  });

  it('keeps the pre-gate behaviour for an embedding that wires no gate', async () => {
    const h = harness(undefined);

    const legacy = decodeStorageACK(await h.handler.handler(
      publishIntent('legacy', { graphScoped: false }).bytes,
      PEER,
    ));
    const update = decodeStorageACK(await h.handler.updateHandler(updateIntent('v2').bytes, PEER));

    expect(isStorageACKDecline(legacy)).toBe(false);
    expect(isStorageACKDecline(update)).toBe(false);
    expect(h.signMessage).toHaveBeenCalledTimes(2);
    // No durable update copy without the gate.
    expect(await h.store.countQuads(layerGraph(MemoryLayer.SharedWorkingMemory, 2))).toBe(0);
  });
});
