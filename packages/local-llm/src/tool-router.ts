import { toOpenAiTool, type McpToolDefinition } from './schema.js';
import { createRelevanceRanker, tokenizeToolText } from './relevance-router.js';

export type ToolProfile = 'auto' | 'chat' | 'status' | 'catalog' | 'read' | 'write';
export type ResolvedToolProfile = Exclude<ToolProfile, 'auto'>;

export interface ToolRoute {
  profile: ResolvedToolProfile;
  tools: McpToolDefinition[];
  reason: string;
  writeBlocked: boolean;
  jsonBytes: number;
  rankedTools: Array<{
    name: string;
    category: ToolCategory;
    score: number;
    lexicalScore: number;
    pinned: boolean;
  }>;
}

export type ToolCategory = 'discovery' | 'status' | 'catalog' | 'read' | 'write' | 'publish' | 'messaging';

export interface ToolRouteRequest {
  prompt: string;
  profile?: ToolProfile;
  allowWrite?: boolean;
  maxTools?: number;
  maxJsonBytes?: number;
  additionalToolNames?: readonly string[];
  additionalReadToolNames?: readonly string[];
  additionalWriteToolNames?: readonly string[];
  domainKeywords?: readonly string[];
  hasPriorEvidence?: boolean;
}

/*
 * Safety compatibility for the pre-annotation built-in MCP surface. These
 * names never participate in relevance ranking. New and adapter tools must
 * declare readOnlyHint; otherwise they fail closed as mutations.
 */
const LEGACY_UNANNOTATED_READ_TOOL_NAMES = new Set<string>([
  'dkg_status',
  'dkg_peer_info',
  'dkg_wallet_balances',
  'dkg_list_context_graphs',
  'dkg_sub_graph_list',
  'dkg_query',
  'dkg_get_entity',
  'dkg_get_entity_sources',
  'dkg_list_activity',
  'dkg_get_agent',
  'dkg_memory_search',
  'dkg_knowledge_asset_query',
  'dkg_knowledge_asset_history',
  'dkg_knowledge_asset_import_artifact_resolve',
  'dkg_knowledge_asset_import_artifact_read_markdown',
  'dkg_check_inbox',
  'dkg_query_catalog_list',
  'dkg_query_catalog_context_graphs',
  'dkg_query_catalog_run',
]);

const LEGACY_UNANNOTATED_WRITE_TOOL_NAMES = new Set<string>([
  'dkg_context_graph_create',
  'dkg_context_graph_register',
  'dkg_subscribe',
  'dkg_sub_graph_create',
  'dkg_knowledge_asset_create',
  'dkg_knowledge_asset_write',
  'dkg_knowledge_asset_finalize',
  'dkg_knowledge_asset_share',
  'dkg_knowledge_asset_publish',
  'dkg_knowledge_asset_pull_from',
  'dkg_knowledge_asset_discard',
  'dkg_knowledge_asset_semantic_enrichment_write',
  'dkg_knowledge_asset_import_file',
  'dkg_send_message',
  'dkg_query_catalog_save',
]);
const STATUS_SIGNAL = /\b(?:node\s+status|status|health|healthy|peers?|wallet|balances?|connectivity)\b/i;
const CATALOG_SIGNAL = /\b(?:query[-\s]+catalogs?|saved\s+quer(?:y|ies)|catalog\s+quer(?:y|ies)|catalogs?)\b/i;
const CONTEXT_GRAPH_DISCOVERY_SIGNAL = /\b(?:cgs?|context\s+graphs?|graph\s+projects?)\b/i;
const WRITE_ACTION_SIGNAL = /\b(?:create|insert|add|write|update|save|publish|share|finalize|discard|delete|import|enrich|register|subscribe|send|mutate|populate|pull|apply|approve|reject|cancel|reset)\b/gi;
const WRITE_ACTION_TOKENS = new Set([
  'create', 'insert', 'add', 'write', 'update', 'save', 'publish', 'share',
  'finalize', 'discard', 'delete', 'import', 'enrich', 'register', 'subscribe',
  'send', 'mutate', 'populate', 'pull', 'apply', 'approve', 'reject', 'cancel',
  'reset', 'enrichment',
]);
const ACTION_EQUIVALENTS = new Map<string, readonly string[]>([
  ['add', ['add', 'create', 'write']],
  ['insert', ['insert', 'create', 'write']],
  ['update', ['update', 'write', 'save']],
  ['delete', ['delete', 'discard']],
  ['enrich', ['enrich', 'enrichment', 'write']],
  ['mutate', ['mutate', 'write']],
  ['populate', ['populate', 'create', 'write']],
]);
const FOLLOW_UP_SIGNAL = /\b(?:it|its|that|those|them|their|same|previous|above|result|entity|asset|graph|query)\b/i;
const CHAT_ONLY_SIGNAL = /^(?:hi|hello|hey|hey\s+there|good\s+(?:morning|afternoon|evening)|thanks?|thank\s+you)[\s!.?]*$/i;

export function isMutatingTool(tool: McpToolDefinition): boolean {
  if (tool.annotations?.readOnlyHint === true) return false;
  if (tool.annotations?.readOnlyHint === false) return true;
  if (tool.annotations?.destructiveHint === true) return true;
  if (LEGACY_UNANNOTATED_WRITE_TOOL_NAMES.has(tool.name)) return true;
  if (LEGACY_UNANNOTATED_READ_TOOL_NAMES.has(tool.name)) return false;
  // Unknown adapter tools without MCP safety annotations fail closed. A name
  // heuristic can miss mutations such as `partner_apply` or `admin_reset`.
  return true;
}

export function classifyTool(tool: McpToolDefinition): ToolCategory {
  const name = tool.name.toLowerCase();
  if (isMutatingTool(tool)) {
    if (/send_message/.test(name)) return 'messaging';
    if (/(subscribe|register|share|publish)/.test(name)) return 'publish';
    return 'write';
  }
  if (/query_catalog/.test(name)) return 'catalog';
  if (/(list_context_graphs|sub_graph_list)/.test(name)) return 'discovery';
  if (/(^|_)status$|peer_info|wallet_balances/.test(name)) return 'status';
  return 'read';
}

function includesKeyword(prompt: string, keywords: readonly string[]): boolean {
  const lower = prompt.toLocaleLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLocaleLowerCase()));
}

function namedTools(prompt: string, tools: McpToolDefinition[]): string[] {
  const lower = prompt.toLowerCase();
  return tools
    .filter((tool) => lower.includes(tool.name.toLowerCase()))
    .map((tool) => tool.name);
}

function hasAffirmativeAction(prompt: string, actionPattern: RegExp): boolean {
  for (const match of prompt.matchAll(actionPattern)) {
    const before = prompt.slice(Math.max(0, (match.index ?? 0) - 64), match.index);
    if (!/\b(?:do\s+not|don't|never)\b[^.!?;\n]{0,48}$/i.test(before)) return true;
  }
  return false;
}

function negatedActionTokens(prompt: string): Set<string> {
  const negated = new Set<string>();
  for (const match of prompt.matchAll(WRITE_ACTION_SIGNAL)) {
    const before = prompt.slice(Math.max(0, (match.index ?? 0) - 64), match.index);
    if (/\b(?:do\s+not|don't|never)\b[^.!?;\n]{0,48}$/i.test(before)) {
      negated.add(match[0].toLowerCase());
    }
  }
  return negated;
}

function profileBoost(profile: ResolvedToolProfile, category: ToolCategory): number {
  if (profile === 'write') {
    if (['write', 'publish', 'messaging'].includes(category)) return 16;
    if (category === 'discovery') return 12;
    return 2;
  }
  if (profile === 'catalog') {
    if (category === 'catalog') return 20;
    if (category === 'discovery') return 6;
    return category === 'read' ? 2 : 0;
  }
  if (profile === 'status') {
    if (category === 'status') return 20;
    if (category === 'discovery') return 10;
    return category === 'read' ? 1 : 0;
  }
  if (profile === 'read') {
    if (category === 'read') return 8;
    if (category === 'discovery' || category === 'catalog') return 4;
  }
  return 0;
}

function directObjectTokens(prompt: string, actionIndex: number, actionLength: number): Set<string> {
  const tail = prompt.slice(actionIndex + actionLength, actionIndex + actionLength + 120)
    .split(/[.!?;\n]/, 1)[0]
    .split(/\b(?:in|inside|within|for|on|from|using|with|to)\b/i, 1)[0]
    .replace(/\bsubgraphs?\b/gi, 'sub graph')
    .replace(/\bcontextgraphs?\b/gi, 'context graph')
    .replace(/\bknowledgeassets?\b/gi, 'knowledge asset');
  return new Set(tokenizeToolText(tail));
}

function explicitlyRequestedMutationTools(
  prompt: string,
  tools: McpToolDefinition[],
  pinnedWriteTools: ReadonlySet<string>,
): Set<string> {
  const allowed = new Set(pinnedWriteTools);
  for (const match of prompt.matchAll(WRITE_ACTION_SIGNAL)) {
    const before = prompt.slice(Math.max(0, (match.index ?? 0) - 64), match.index);
    if (/\b(?:do\s+not|don't|never)\b[^.!?;\n]{0,48}$/i.test(before)) continue;
    const action = match[0].toLowerCase();
    const acceptedActions = new Set(ACTION_EQUIVALENTS.get(action) ?? [action]);
    const targetTokens = directObjectTokens(prompt, match.index ?? 0, match[0].length);
    const eligible = tools
      .filter(isMutatingTool)
      .map((tool) => {
        const nameTokens = tokenizeToolText(tool.name);
        const actionTokens = nameTokens.filter((token) => WRITE_ACTION_TOKENS.has(token));
        const subjectTokens = nameTokens.filter((token) =>
          token !== 'dkg' && !WRITE_ACTION_TOKENS.has(token));
        const targetMatches = subjectTokens.filter((token) => targetTokens.has(token)).length;
        return { tool, actionTokens, targetMatches };
      })
      .filter(({ actionTokens }) => actionTokens.some((token) => acceptedActions.has(token)));
    const bestTargetMatches = Math.max(0, ...eligible.map(({ targetMatches }) => targetMatches));
    for (const candidate of eligible) {
      if (bestTargetMatches === 0 || candidate.targetMatches === bestTargetMatches) {
        allowed.add(candidate.tool.name);
      }
    }
  }
  return allowed;
}

function createRoute(
  tools: McpToolDefinition[],
  ranker: ReturnType<typeof createRelevanceRanker<McpToolDefinition>>,
  options: ToolRouteRequest,
): ToolRoute {
  const prompt = options.prompt.trim();
  const requestedProfile = options.profile ?? 'auto';
  const allowWrite = options.allowWrite ?? false;
  const maxTools = options.maxTools ?? 8;
  const maxJsonBytes = options.maxJsonBytes ?? 18_000;
  const explicitNames = namedTools(prompt, tools);
  const domainIntent = includesKeyword(prompt, options.domainKeywords ?? []);
  const priorFollowUp = Boolean(options.hasPriorEvidence && FOLLOW_UP_SIGNAL.test(prompt));
  const metadataIntent = ranker.maxLexicalScore(prompt, WRITE_ACTION_TOKENS) > 0;
  const hasToolIntent = metadataIntent || domainIntent || explicitNames.length > 0 || priorFollowUp;
  const namedMutation = explicitNames.some((name) => {
    const tool = tools.find((candidate) => candidate.name === name);
    return tool ? isMutatingTool(tool) : false;
  });
  const writeIntent = requestedProfile === 'write'
    || namedMutation
    || (hasToolIntent && hasAffirmativeAction(prompt, WRITE_ACTION_SIGNAL));
  if (writeIntent && !allowWrite) {
    return {
      profile: 'chat',
      tools: [],
      reason: 'The prompt requests a mutation, but write tools are disabled.',
      writeBlocked: true,
      jsonBytes: 0,
      rankedTools: [],
    };
  }

  let resolved: ResolvedToolProfile;
  if (requestedProfile !== 'auto') {
    resolved = requestedProfile;
  } else if (CHAT_ONLY_SIGNAL.test(prompt) || !hasToolIntent) {
    resolved = 'chat';
  } else if (writeIntent) {
    resolved = 'write';
  } else if (CATALOG_SIGNAL.test(prompt)) {
    resolved = 'catalog';
  } else if (STATUS_SIGNAL.test(prompt)) {
    resolved = 'status';
  } else {
    resolved = 'read';
  }

  if (resolved === 'chat') {
    return {
      profile: resolved,
      tools: [],
      reason: 'No relevant MCP tool metadata matched the prompt.',
      writeBlocked: false,
      jsonBytes: 0,
      rankedTools: [],
    };
  }

  const pinned = new Set([
    ...explicitNames,
    ...(resolved === 'read' && CONTEXT_GRAPH_DISCOVERY_SIGNAL.test(prompt)
      ? ['dkg_list_context_graphs']
      : []),
    ...(options.additionalToolNames ?? []),
    ...(domainIntent && resolved === 'write' ? options.additionalWriteToolNames ?? [] : []),
    ...(domainIntent && resolved !== 'write' ? options.additionalReadToolNames ?? [] : []),
  ]);
  const explicitlyNamedMutations = new Set(explicitNames.filter((name) => {
    const tool = tools.find((candidate) => candidate.name === name);
    return tool ? isMutatingTool(tool) : false;
  }));
  const requestedMutations = explicitlyRequestedMutationTools(
    prompt,
    tools,
    explicitlyNamedMutations,
  );
  const negated = negatedActionTokens(prompt);
  const excluded = new Set(tools
    .filter((tool) => isMutatingTool(tool)
      && (resolved !== 'write' || !requestedMutations.has(tool.name)))
    .map((tool) => tool.name));
  for (const tool of tools) {
    if (!isMutatingTool(tool)) continue;
    const toolTokens = new Set(tool.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    if ([...negated].some((token) => toolTokens.has(token))) excluded.add(tool.name);
  }
  const ranked = ranker.rank({
    query: prompt,
    limit: maxTools,
    jsonBudget: maxJsonBytes,
    pinnedNames: pinned,
    excludedNames: excluded,
    anchorNames: resolved === 'write' ? ['dkg_list_context_graphs'] : [],
    categoryBoost: (category) => profileBoost(resolved, category as ToolCategory),
  });

  return {
    profile: resolved,
    tools: ranked.selected.map((candidate) => candidate.item),
    reason: `Data-driven ${resolved} route selected ${ranked.selected.length}/${tools.length} MCP schema(s) `
      + `within ${ranked.jsonBytes}/${maxJsonBytes} JSON bytes.`,
    writeBlocked: false,
    jsonBytes: ranked.jsonBytes,
    rankedTools: ranked.selected.map((candidate) => ({
      name: candidate.name,
      category: candidate.category as ToolCategory,
      score: candidate.score,
      lexicalScore: candidate.lexicalScore,
      pinned: candidate.pinned,
    })),
  };
}

export function createToolRouter(tools: McpToolDefinition[]): (request: ToolRouteRequest) => ToolRoute {
  const ranker = createRelevanceRanker(tools.map((tool) => ({
    item: tool,
    name: tool.name,
    description: tool.description,
    schema: tool.inputSchema,
    category: classifyTool(tool),
    jsonBytes: JSON.stringify(toOpenAiTool(tool)).length,
  })));
  return (request) => createRoute(tools, ranker, request);
}

export function routeTools(options: ToolRouteRequest & { tools: McpToolDefinition[] }): ToolRoute {
  const { tools, ...request } = options;
  return createToolRouter(tools)(request);
}
