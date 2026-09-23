// SPDX-License-Identifier: Apache-2.0

/**
 * A real ethers `JsonRpcProvider` over a scripted HTTP transport.
 *
 * The fake sits at `FetchRequest.getUrlFunc`, below ethers: every refusal is
 * an HTTP status plus a JSON body, and ethers itself builds the error the
 * adapter sees — `UNKNOWN_ERROR` with the JSON-RPC `{ code, message }` nested
 * for an HTTP 200 error body, `SERVER_ERROR` with `info.responseBody` for an
 * HTTP 4xx/5xx. That is the shape the classifier meets in production, which
 * hand-built nested objects would not prove.
 */

import { FetchRequest, JsonRpcProvider, Network } from 'ethers';

/** A JSON-RPC log as a node returns it. */
export interface FakeRpcLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logIndex: number;
}

/** How the endpoint answers one eth_getLogs, instead of serving logs. */
export type FakeLogRpcRefusal =
  | { readonly rpcError: { readonly code: number; readonly message: string }; readonly httpStatus?: number }
  /** An HTTP error whose body is not JSON-RPC at all (a gateway's HTML or text page). */
  | { readonly rawBody: string; readonly httpStatus: number; readonly contentType?: string }
  | { readonly networkError: string };

export interface FakeLogRpcRequest {
  readonly method: string;
  readonly fromBlock?: number;
  readonly toBlock?: number;
}

export interface FakeLogRpcOptions {
  readonly url: string;
  readonly chainId?: number;
  readonly head: () => number;
  /** Every log the chain holds; eth_getLogs filters by range, address and topic0. */
  readonly logs?: () => readonly FakeRpcLog[];
  /** Refuse a request (return a refusal) or serve it (return undefined). */
  readonly refuse?: (request: { fromBlock: number; toBlock: number; head: number }) => FakeLogRpcRefusal | undefined;
  /** Delay before answering an eth_getLogs, for deadline tests. */
  readonly delay?: (request: FakeLogRpcRequest) => Promise<void>;
}

export interface FakeLogRpc {
  /** The URL the provider was built on: an adapter configures it for this endpoint. */
  readonly url: string;
  readonly provider: JsonRpcProvider;
  readonly requests: FakeLogRpcRequest[];
  /** eth_getLogs ranges only, in the order they were sent. */
  logRanges(): Array<[number, number]>;
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: 'OK',
  400: 'Bad Request',
  403: 'Forbidden',
  408: 'Request Timeout',
  413: 'Payload Too Large',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

const hex = (value: number): string => `0x${value.toString(16)}`;

function blockParam(value: unknown, head: number): number {
  if (value === undefined || value === 'latest') return head;
  if (typeof value === 'string' && value.startsWith('0x')) return Number.parseInt(value, 16);
  throw new Error(`fake RPC cannot resolve block ${String(value)}`);
}

export function fakeLogRpc(options: FakeLogRpcOptions): FakeLogRpc {
  const requests: FakeLogRpcRequest[] = [];
  const request = new FetchRequest(options.url);
  request.getUrlFunc = async (req) => {
    const payload = JSON.parse(new TextDecoder().decode(req.body!)) as {
      id: number;
      method: string;
      params: unknown[];
    };
    const head = options.head();
    const respond = (status: number, body: unknown) => ({
      statusCode: status,
      statusMessage: STATUS_TEXT[status] ?? 'Status',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(body)),
    });
    const ok = (result: unknown) => respond(200, { jsonrpc: '2.0', id: payload.id, result });

    if (payload.method === 'eth_chainId') {
      requests.push({ method: payload.method });
      return ok(hex(options.chainId ?? 8453));
    }
    if (payload.method === 'eth_blockNumber') {
      requests.push({ method: payload.method });
      return ok(hex(head));
    }
    if (payload.method !== 'eth_getLogs') {
      throw new Error(`fake RPC does not serve ${payload.method}`);
    }
    const filter = payload.params[0] as {
      address?: string | string[];
      topics?: Array<string | string[] | null>;
      fromBlock?: string;
      toBlock?: string;
    };
    const fromBlock = blockParam(filter.fromBlock, head);
    const toBlock = blockParam(filter.toBlock, head);
    const entry = { method: payload.method, fromBlock, toBlock };
    requests.push(entry);
    await options.delay?.(entry);

    const refusal = options.refuse?.({ fromBlock, toBlock, head });
    if (refusal !== undefined) {
      if ('networkError' in refusal) throw new TypeError(refusal.networkError);
      if ('rawBody' in refusal) {
        return {
          statusCode: refusal.httpStatus,
          statusMessage: STATUS_TEXT[refusal.httpStatus] ?? 'Status',
          headers: { 'content-type': refusal.contentType ?? 'text/plain' },
          body: new TextEncoder().encode(refusal.rawBody),
        };
      }
      return respond(refusal.httpStatus ?? 200, {
        jsonrpc: '2.0',
        id: payload.id,
        error: refusal.rpcError,
      });
    }

    const addresses = filter.address === undefined
      ? undefined
      : (Array.isArray(filter.address) ? filter.address : [filter.address]).map((a) => a.toLowerCase());
    const topic0 = filter.topics?.[0];
    const topics = topic0 == null
      ? undefined
      : (Array.isArray(topic0) ? topic0 : [topic0]).map((t) => t.toLowerCase());
    const logs = (options.logs?.() ?? []).filter((log) => (
      log.blockNumber >= fromBlock
      && log.blockNumber <= toBlock
      && (addresses === undefined || addresses.includes(log.address.toLowerCase()))
      && (topics === undefined || topics.includes(log.topics[0]!.toLowerCase()))
    ));
    return ok(logs.map((log) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
      blockNumber: hex(log.blockNumber),
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      transactionIndex: '0x0',
      logIndex: hex(log.logIndex),
      removed: false,
    })));
  };
  const network = Network.from(options.chainId ?? 8453);
  const provider = new JsonRpcProvider(request, network, {
    staticNetwork: network,
    batchMaxCount: 1,
    cacheTimeout: -1,
  });
  return {
    url: options.url,
    provider,
    requests,
    logRanges: () => requests
      .filter((r) => r.method === 'eth_getLogs')
      .map((r) => [r.fromBlock!, r.toBlock!]),
  };
}

/** mainnet.base.org, as probed on 2026-09-23: a 2,000-block span cap, any depth. */
export const BASE_SPAN_CAP_REFUSAL = {
  rpcError: { code: -32614, message: 'eth_getLogs is limited to a 2,000 range' },
} as const;

/** base-rpc.publicnode.com: blocks about four hours old are "archive". */
export const PUBLICNODE_ARCHIVE_REFUSAL = {
  rpcError: {
    code: -32602,
    message: 'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode',
  },
} as const;

/** base.drpc.org free plan: refuses even a 2,000-block span of older blocks. */
export const DRPC_FREE_PLAN_REFUSAL = {
  httpStatus: 400,
  rpcError: { code: 35, message: 'ranges over 10000 blocks are not supported on free plan' },
} as const;

/**
 * The default Base mainnet RPC set (`network/mainnet-base.json`), modelled on
 * the 2026-09-23 probes. `recentBlocks` is how far behind head the two backups
 * still serve.
 */
export function baseDefaultRpcSet(options: {
  head: () => number;
  logs?: () => readonly FakeRpcLog[];
  recentBlocks?: number;
  primaryRefuse?: FakeLogRpcOptions['refuse'];
}) {
  const recentBlocks = options.recentBlocks ?? 1_000;
  const tooOld = (fromBlock: number, head: number) => fromBlock < head - recentBlocks;
  const primary = fakeLogRpc({
    url: 'https://mainnet.base.org',
    head: options.head,
    logs: options.logs,
    refuse: (request) => options.primaryRefuse?.(request) ?? (
      request.toBlock - request.fromBlock + 1 > 2_000 ? BASE_SPAN_CAP_REFUSAL : undefined
    ),
  });
  const publicnode = fakeLogRpc({
    url: 'https://base-rpc.publicnode.com',
    head: options.head,
    logs: options.logs,
    refuse: ({ fromBlock, head }) => (tooOld(fromBlock, head) ? PUBLICNODE_ARCHIVE_REFUSAL : undefined),
  });
  const drpc = fakeLogRpc({
    url: 'https://base.drpc.org',
    head: options.head,
    logs: options.logs,
    refuse: ({ fromBlock, head }) => (tooOld(fromBlock, head) ? DRPC_FREE_PLAN_REFUSAL : undefined),
  });
  return { primary, publicnode, drpc };
}
