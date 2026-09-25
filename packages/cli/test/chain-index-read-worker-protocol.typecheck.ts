import type { KnowledgeAssetReadModelFactoryOptions } from '@origintrail-official/dkg-chain';
import type { KnowledgeAssetReadSnapshot, KnowledgeAssetResultByKind } from '@origintrail-official/dkg-chain/internal/chain-index-worker';
import { evaluateKnowledgeAssetSnapshot, ChainEventDecoderRegistry } from '@origintrail-official/dkg-chain/internal/chain-index-worker';
import type {
  ChainIndexReadRequest, ChainIndexReadResponse, ChainIndexReadFence,
} from '../src/daemon/worker/chain-index-read-worker-protocol.js';

declare const model: KnowledgeAssetReadModelFactoryOptions;
declare const fence: ChainIndexReadFence;
const requestBase = { type: 'read' as const, id: 1, model, options: {}, deadlineAt: 100 };
const responseBase = { id: 1, rowsRead: 1, readMs: 1, decodeMs: 1 };
const bound = { kind: 'bound' as const, contextGraphId: 7n, asOfBlockNumber: 10 };

const ordinal: ChainIndexReadRequest = { ...requestBase, method: 'ordinal', key: 7n, index: 0n };
// @ts-expect-error The ordinal index is mandatory.
const missingIndex: ChainIndexReadRequest = { ...requestBase, method: 'ordinal', key: 7n };
// @ts-expect-error Binding reads cannot carry an ordinal index.
const bindingWithIndex: ChainIndexReadRequest = { ...requestBase, method: 'binding', key: 1n, index: 0n };
// @ts-expect-error List reads cannot carry an ordinal index.
const listWithIndex: ChainIndexReadRequest = { ...requestBase, method: 'list', key: 7n, index: 0n };
const served: ChainIndexReadResponse = { ...responseBase, method: 'binding', reason: 'served', result: bound, fence };
// @ts-expect-error Served replies require a result.
const missingResult: ChainIndexReadResponse = { ...responseBase, method: 'binding', reason: 'served', fence };
// @ts-expect-error Served replies require a cursor fence.
const missingFence: ChainIndexReadResponse = { ...responseBase, method: 'binding', reason: 'served', result: bound };
// @ts-expect-error An ordinal response cannot carry a binding result.
const wrongResult: ChainIndexReadResponse = { ...responseBase, method: 'ordinal', reason: 'served', result: bound, fence };
// @ts-expect-error Refused replies cannot carry a usable result.
const refusedResult: ChainIndexReadResponse = { ...responseBase, method: 'binding', reason: 'proof-miss', result: bound };
// @ts-expect-error Refusal reasons are a closed protocol union.
const unknownReason: ChainIndexReadResponse = { ...responseBase, method: 'binding', reason: 'maybe' };

declare const snapshot: KnowledgeAssetReadSnapshot<'ordinal'>;
const evaluated: Promise<KnowledgeAssetResultByKind['ordinal'] | undefined> =
  evaluateKnowledgeAssetSnapshot(snapshot, new ChainEventDecoderRegistry());
// @ts-expect-error Evaluation through the published internal subpath retains its operation.
const wrongEvaluation: Promise<KnowledgeAssetResultByKind['list'] | undefined> =
  evaluateKnowledgeAssetSnapshot(snapshot, new ChainEventDecoderRegistry());
void [ordinal, missingIndex, bindingWithIndex, listWithIndex, served, missingResult, missingFence,
  wrongResult, refusedResult, unknownReason, evaluated, wrongEvaluation];
