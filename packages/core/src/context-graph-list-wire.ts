/** Canonical GET /api/context-graph/list wire contract (GH #1765). */

export const CONTEXT_GRAPH_LIST_PROJECTIONS = ['full', 'summary'] as const;
export type ContextGraphListProjection = (typeof CONTEXT_GRAPH_LIST_PROJECTIONS)[number];

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
