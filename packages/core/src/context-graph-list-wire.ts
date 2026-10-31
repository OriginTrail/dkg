/** Canonical GET /api/context-graph/list wire contract (GH #1765). */

export const CONTEXT_GRAPH_LIST_PROJECTIONS = ['full', 'summary'] as const;
export type ContextGraphListProjection = (typeof CONTEXT_GRAPH_LIST_PROJECTIONS)[number];

export const CONTEXT_GRAPH_LIST_DEFAULT_LIMIT = 50;
export const CONTEXT_GRAPH_LIST_MAX_LIMIT = 100;
export const CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES = 64 * 1024;

export const CONTEXT_GRAPH_LIST_ERROR_CODES = {
  entryTooLarge: 'CONTEXT_GRAPH_LIST_ENTRY_TOO_LARGE',
  snapshotChanged: 'CONTEXT_GRAPH_LIST_SNAPSHOT_CHANGED',
} as const;
export type ContextGraphListErrorCode =
  (typeof CONTEXT_GRAPH_LIST_ERROR_CODES)[keyof typeof CONTEXT_GRAPH_LIST_ERROR_CODES];

export function isContextGraphListErrorCode(value: unknown): value is ContextGraphListErrorCode {
  return Object.values(CONTEXT_GRAPH_LIST_ERROR_CODES).some((code) => code === value);
}

export interface ContextGraphListErrorResponse {
  error: string;
  code: ContextGraphListErrorCode;
  maxSerializedBytes?: number;
}

/** Decode the protocol-significant error vocabulary without an unchecked body cast. */
export function decodeContextGraphListErrorResponse(
  value: unknown,
): ContextGraphListErrorResponse | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const response = value as Partial<ContextGraphListErrorResponse>;
  if (
    typeof response.error !== 'string'
    || !isContextGraphListErrorCode(response.code)
    || (
      response.maxSerializedBytes !== undefined
      && (!Number.isSafeInteger(response.maxSerializedBytes) || response.maxSerializedBytes < 1)
    )
  ) {
    return undefined;
  }
  return {
    error: response.error,
    code: response.code,
    ...(response.maxSerializedBytes === undefined
      ? {}
      : { maxSerializedBytes: response.maxSerializedBytes }),
  };
}

/**
 * Chain-public facts attached to a `listContextGraphs` row. Every field is
 * public on chain, including for private graphs; nothing here comes from the
 * local store, so it never reveals a private graph's cleartext name.
 */
export interface ContextGraphListOnChainFacts {
  /** Positive decimal ContextGraphStorage id. */
  readonly id: string;
  /** From the write-once on-chain access policy: 0 = public, 1 = private. */
  readonly access: 'public' | 'private' | 'unknown';
  /** 0 = curated (only the publish authority may publish), 1 = open; null until observed. */
  readonly publishPolicy: 'curated' | 'open' | 'unknown' | null;
  readonly publishAuthority: string | null;
  /** Current ERC-721 owner (the creator unless ownership was transferred); null until observed. */
  readonly owner: string | null;
  /** ISO-8601 creation time from the on-chain timestamp; null until enumerated. */
  readonly createdAt: string | null;
  /** On-chain active flag; `false` once deactivated; null until enumerated. */
  readonly active: boolean | null;
  /** Curator-committed name hash; null when the curator opted out. */
  readonly nameHash: string | null;
  /** Block of the newest observation behind these facts. */
  readonly observedAtBlock: number;
}

/** Canonical row returned by DKGAgent.listContextGraphs and the legacy endpoint. */
export interface ContextGraphListFullRow {
  id: string;
  uri: string;
  name: string;
  description?: string;
  creator?: string;
  curator?: string;
  accessPolicy?: string;
  createdAt?: string;
  isSystem: boolean;
  subscribed: boolean;
  synced: boolean;
  onChainId?: string;
  callerInvolved?: boolean;
  /**
   * `approved-metadata-pending` while the curator has approved the caller's
   * join and the graph's member list naming the caller is still on its way
   * (#3421). `callerInvolved` stays `false` until it arrives; another join
   * request is not needed.
   */
  joinState?: 'approved-metadata-pending';
  /**
   * `false` when the node knows this graph only by its on-chain name hash:
   * `id` and `name` are then that hash, never a guessed cleartext. Subscribing
   * by the hash lets the node resolve and verify the cleartext id.
   */
  nameKnown?: boolean;
  /** Chain-public ContextGraphStorage facts, when the node has observed them. */
  onChain?: ContextGraphListOnChainFacts;
}

/** Bounded projection used by list and picker views. */
export interface ContextGraphListSummaryRow {
  id: string;
  name: string;
  nameTruncated?: true;
  description?: string;
  descriptionTruncated?: true;
  curator?: string;
  accessPolicy?: string;
  isSystem: boolean;
  subscribed: boolean;
  synced: boolean;
  onChainId?: string;
  callerInvolved?: boolean;
  joinState?: ContextGraphListFullRow['joinState'];
  nameKnown?: boolean;
}

export type ContextGraphListRow = ContextGraphListFullRow | ContextGraphListSummaryRow;

export interface ContextGraphListPageOptions {
  limit?: number;
  /** Opaque cursor from a previous response. Repeat every other option. */
  cursor?: string;
  projection?: ContextGraphListProjection;
  subscribed?: boolean;
  synced?: boolean;
  onChain?: boolean;
  q?: string;
}

/** One total mapping keeps route parsing and every client serializer aligned. */
export const CONTEXT_GRAPH_LIST_WIRE_KEYS = {
  limit: 'limit',
  cursor: 'cursor',
  projection: 'projection',
  subscribed: 'subscribed',
  synced: 'synced',
  onChain: 'onChain',
  q: 'q',
} as const satisfies Record<keyof ContextGraphListPageOptions, string>;

export const CONTEXT_GRAPH_LIST_WIRE_KEY_VALUES: readonly string[] =
  Object.values(CONTEXT_GRAPH_LIST_WIRE_KEYS);

export function serializeContextGraphListOptions(options: ContextGraphListPageOptions): string {
  const params = new URLSearchParams();
  const optionNames = Object.keys(CONTEXT_GRAPH_LIST_WIRE_KEYS) as
    Array<keyof ContextGraphListPageOptions>;
  for (const option of optionNames) {
    const value = options[option];
    if (value !== undefined) params.set(CONTEXT_GRAPH_LIST_WIRE_KEYS[option], String(value));
  }
  return params.toString();
}

export interface ContextGraphListPageMetadata {
  returned: number;
  total: number;
  limit: number;
  serializedBytes: number;
  maxSerializedBytes: number;
}

export interface ContextGraphListPageResponse<Row extends ContextGraphListRow = ContextGraphListRow> {
  contextGraphs: Row[];
  nextCursor?: string;
  page: ContextGraphListPageMetadata;
}

export interface ContextGraphListLegacyResponse {
  contextGraphs: ContextGraphListFullRow[];
}
