// SPDX-License-Identifier: Apache-2.0

/**
 * The real chain adapter over one scripted endpoint that serves `latest` reads
 * and refuses the read pinned to a block number, the way an endpoint without
 * historical state does. It is the only endpoint, so the adapter has no
 * version view to give and reports why.
 *
 * For suites about what a caller of the version read says in that case, from
 * the adapter's own report rather than a literal one. The endpoint's URL has a
 * path and a query, as a keyed provider URL has, and the refusal carries that
 * URL in its text, as the transport's does: neither may reach a message.
 */

import { expect } from 'vitest';
import {
  EVMChainAdapter,
  type KnowledgeAssetVersionSnapshotReadOptions,
  type KnowledgeAssetVersionSnapshotUnavailable,
} from '@origintrail-official/dkg-chain';

export const REFUSING_ENDPOINT_CHAIN_ID = 'evm:31337';
const REFUSING_ENDPOINT_URL = 'https://only.example/v3/SECRET-PATH-KEY?apikey=SECRET-QUERY-KEY';

/** What the adapter reports for it, and the chain package's words for that report. */
export const REFUSING_ENDPOINT_REPORT: KnowledgeAssetVersionSnapshotUnavailable = {
  reason: 'endpoints-failed',
  endpointCount: 1,
  endpoints: [
    { position: 1, host: 'only.example', stage: 'pinned-read', failure: 'http-client-error', httpStatus: 400 },
  ],
};
export const REFUSING_ENDPOINT_WORDS = 'endpoint 1 of 1 (only.example) refused a block-pinned read (http 400)';

export type VersionSnapshotRead = (
  kaId: bigint,
  options?: KnowledgeAssetVersionSnapshotReadOptions,
) => Promise<unknown>;

/** The adapter's version read, and how often its endpoint was asked for the `latest` block. */
export function adapterOverRefusingEndpoint(): {
  readKnowledgeAssetVersionSnapshot: VersionSnapshotRead;
  latestReads(): number;
} {
  const adapter = new EVMChainAdapter({
    rpcUrl: REFUSING_ENDPOINT_URL,
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: REFUSING_ENDPOINT_CHAIN_ID,
    staticNetwork: false,
    finalityConfirmations: 1,
  } as never) as unknown as Record<string, unknown>;
  let latestReads = 0;
  adapter.initialized = true;
  adapter.init = async () => {};
  adapter.ensureConfiguredStaticChainIdValidated = async () => 31337n;
  adapter.contracts = { knowledgeAssetStorage: { target: `0x${'33'.repeat(20)}` } };
  adapter.providers = [{
    async getNetwork() { return { chainId: 31337n }; },
    async getBlock() {
      latestReads += 1;
      return { number: 500, hash: `0x${'50'.repeat(32)}` };
    },
  }];
  adapter.rebindContract = () => ({
    async getLatestMerkleRoot() {
      // The shape ethers gives an HTTP 400: the request URL, key and all, is in the message.
      throw Object.assign(
        new Error(`server response 400 Bad Request (request={ url: "${REFUSING_ENDPOINT_URL}" })`),
        {
          code: 'SERVER_ERROR',
          response: { statusCode: 400 },
          info: { requestUrl: REFUSING_ENDPOINT_URL, responseStatus: '400 Bad Request' },
        },
      );
    },
    async getKnowledgeAssetUpdateContext() { return { 0: 1n, length: 7 }; },
    async getLatestMerkleRootAuthor() { return `0x${'11'.repeat(20)}`; },
    async getLatestMerkleRootPublisher() { return `0x${'22'.repeat(20)}`; },
  });
  const read = adapter.readKnowledgeAssetVersionSnapshot as VersionSnapshotRead;
  return {
    readKnowledgeAssetVersionSnapshot: (kaId, options) => read.call(adapter, kaId, options),
    latestReads: () => latestReads,
  };
}

/** Nothing of the endpoint's URL beyond its host: no key, no path, no query, no scheme. */
export function expectNoEndpointUrl(produced: string): void {
  expect(produced).not.toContain('SECRET');
  expect(produced).not.toContain('apikey');
  expect(produced).not.toContain('/v3');
  expect(produced).not.toContain('://');
}
