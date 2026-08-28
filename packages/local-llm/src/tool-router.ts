import type { McpToolDefinition } from './schema.js';

export type ToolProfile = 'auto' | 'chat' | 'status' | 'catalog' | 'read' | 'write';
export type ResolvedToolProfile = Exclude<ToolProfile, 'auto'>;

export interface ToolRoute {
  profile: ResolvedToolProfile;
  tools: McpToolDefinition[];
  reason: string;
  writeBlocked: boolean;
}

export const STATUS_TOOL_NAMES = [
  'dkg_status',
  'dkg_peer_info',
  'dkg_wallet_balances',
  'dkg_list_context_graphs',
  'dkg_sub_graph_list',
] as const;

export const CATALOG_TOOL_NAMES = [
  'dkg_status',
  'dkg_list_context_graphs',
  'dkg_query_catalog_list',
  'dkg_query_catalog_run',
] as const;

export const READ_TOOL_NAMES = [
  ...STATUS_TOOL_NAMES,
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
  'dkg_query_catalog_run',
] as const;

export const WRITE_TOOL_NAMES = [
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
] as const;

const KNOWN_READ_TOOLS = new Set<string>(READ_TOOL_NAMES);
const KNOWN_WRITE_TOOLS = new Set<string>(WRITE_TOOL_NAMES);
const DKG_SIGNAL = /\b(?:dkg|context\s+graph|sub-?graph|knowledge\s+asset|triples?|rdf|sparql|entity|provenance|verifiable\s+memory|query[-\s]+catalog|saved\s+quer(?:y|ies)|peer|wallet|inbox)\b/i;
const STATUS_SIGNAL = /\b(?:status|health|healthy|peers?|wallet|balances?|joined\s+(?:context\s+)?graphs?)\b/i;
const CATALOG_SIGNAL = /\b(?:query[-\s]+catalog|saved\s+quer(?:y|ies)|catalog\s+quer(?:y|ies))\b/i;
const WRITE_ACTION_SIGNAL = /\b(?:create|insert|add|write|update|save|publish|share|finalize|discard|delete|import|enrich|register|subscribe|send|mutate)\b/gi;
const FOLLOW_UP_SIGNAL = /\b(?:it|its|that|those|them|their|same|previous|above|result|entity|asset|graph|query)\b/i;

export function isMutatingTool(tool: McpToolDefinition): boolean {
  if (KNOWN_WRITE_TOOLS.has(tool.name)) return true;
  if (KNOWN_READ_TOOLS.has(tool.name)) return false;
  if (tool.annotations?.destructiveHint === true) return true;
  if (tool.annotations?.readOnlyHint === true) return false;
  if (tool.annotations?.readOnlyHint === false) return true;
  // Unknown adapter tools without MCP safety annotations fail closed. A name
  // heuristic can miss mutations such as `partner_apply` or `admin_reset`.
  return true;
}

function hasWriteIntent(
  prompt: string,
  tools: McpToolDefinition[],
  hasDomainIntent: boolean,
): boolean {
  const namedMutation = tools.some((tool) =>
    isMutatingTool(tool) && prompt.toLowerCase().includes(tool.name.toLowerCase()));
  return namedMutation
    || ((DKG_SIGNAL.test(prompt) || hasDomainIntent) && hasAffirmativeAction(prompt, WRITE_ACTION_SIGNAL));
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

function namesForReadPrompt(prompt: string): string[] {
  const names = ['dkg_list_context_graphs', 'dkg_query_catalog_list', 'dkg_query_catalog_run'];
  if (/\b(?:sparql|select|construct|ask|raw\s+query|triple)\b/i.test(prompt)) names.push('dkg_query');
  if (/\b(?:entity|iri|uri|facts?|describe|neighbou?r)\b/i.test(prompt)) {
    names.push('dkg_get_entity', 'dkg_get_entity_sources');
  }
  if (/\b(?:memory|search|find|lookup|retrieve|retrieval|relevant)\b/i.test(prompt)) names.push('dkg_memory_search');
  if (/\b(?:activity|recent|decision|task|turn)\b/i.test(prompt)) names.push('dkg_list_activity');
  if (/\b(?:agent|author|authored)\b/i.test(prompt)) names.push('dkg_get_agent');
  if (/\b(?:asset|assertion|history|version)\b/i.test(prompt)) {
    names.push('dkg_knowledge_asset_query', 'dkg_knowledge_asset_history');
  }
  if (/\b(?:sub-?graph|partition|slice)\b/i.test(prompt)) names.push('dkg_sub_graph_list');
  if (/\b(?:inbox|message)\b/i.test(prompt)) names.push('dkg_check_inbox');
  if (names.length === 3) names.push('dkg_memory_search', 'dkg_query', 'dkg_get_entity');
  return names;
}

function namesForWritePrompt(prompt: string): string[] {
  const names: string[] = [];
  const contextGraphCreateIntent = /\b(?:create|add)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:dkg\s+)?context\s+graphs?\b|\bnew\s+(?:dkg\s+)?context\s+graphs?\b/i.test(prompt);
  const subGraphCreateIntent = /\b(?:create|add)\s+(?:a\s+|an\s+)?(?:new\s+)?sub-?graphs?\b|\bnew\s+sub-?graphs?\b/i.test(prompt);
  if (/\bquery[-\s]+catalog|saved\s+query/i.test(prompt)) {
    if (/\bsave|update|create|add/i.test(prompt)) names.push('dkg_query_catalog_save');
    names.push('dkg_query_catalog_list', 'dkg_query_catalog_run');
  }
  if (/\bcontext\s+graph/i.test(prompt)) {
    if (contextGraphCreateIntent) names.push('dkg_context_graph_create');
    if (/\bregister/i.test(prompt)) names.push('dkg_context_graph_register');
  }
  if (/\bsub-?graph/i.test(prompt)) {
    if (subGraphCreateIntent) names.push('dkg_sub_graph_create');
    names.push('dkg_sub_graph_list');
  }
  if (/\bsubscribe/i.test(prompt)) names.push('dkg_subscribe');
  if (/\b(?:knowledge\s+asset|assertion|quads?|triples?|rdf)\b/i.test(prompt)) {
    if (/\bcreate|insert|add/i.test(prompt)) names.push('dkg_knowledge_asset_create');
    if (/\bwrite|update/i.test(prompt)) names.push('dkg_knowledge_asset_write');
    if (/\bfinalize/i.test(prompt)) names.push('dkg_knowledge_asset_finalize');
    if (hasAffirmativeAction(prompt, /\bshare\b/gi)) {
      names.push('dkg_knowledge_asset_share');
    }
    if (hasAffirmativeAction(prompt, /\bpublish\b/gi)) {
      names.push('dkg_knowledge_asset_publish');
    }
    if (/\bdiscard|delete/i.test(prompt)) names.push('dkg_knowledge_asset_discard');
    if (/\bimport/i.test(prompt)) names.push('dkg_knowledge_asset_import_file');
    if (/\benrich/i.test(prompt)) names.push('dkg_knowledge_asset_semantic_enrichment_write');
  }
  if (/\b(?:send|message)\b/i.test(prompt)) names.push('dkg_send_message');
  names.push('dkg_list_context_graphs', 'dkg_status');
  return names;
}

function selectByNames(
  available: McpToolDefinition[],
  names: readonly string[],
  maxTools: number,
): McpToolDefinition[] {
  const order = new Map(names.map((name, index) => [name, index]));
  return available
    .filter((tool) => order.has(tool.name))
    .sort((left, right) => order.get(left.name)! - order.get(right.name)!)
    .slice(0, maxTools);
}

export function routeTools(options: {
  prompt: string;
  tools: McpToolDefinition[];
  profile?: ToolProfile;
  allowWrite?: boolean;
  maxTools?: number;
  additionalToolNames?: readonly string[];
  additionalReadToolNames?: readonly string[];
  additionalWriteToolNames?: readonly string[];
  domainKeywords?: readonly string[];
  hasPriorEvidence?: boolean;
}): ToolRoute {
  const prompt = options.prompt.trim();
  const profile = options.profile ?? 'auto';
  const allowWrite = options.allowWrite ?? false;
  const maxTools = options.maxTools ?? 8;
  const explicitNames = namedTools(prompt, options.tools);
  const domainIntent = includesKeyword(prompt, options.domainKeywords ?? []);
  const writeIntent = hasWriteIntent(prompt, options.tools, domainIntent) || profile === 'write';
  if (writeIntent && !allowWrite) {
    return {
      profile: 'chat',
      tools: [],
      reason: 'The prompt requests a mutation, but write tools are disabled.',
      writeBlocked: true,
    };
  }

  let resolved: ResolvedToolProfile;
  if (profile !== 'auto') {
    resolved = profile;
  } else if (writeIntent) {
    resolved = 'write';
  } else if (CATALOG_SIGNAL.test(prompt)) {
    resolved = 'catalog';
  } else if (DKG_SIGNAL.test(prompt) && STATUS_SIGNAL.test(prompt)) {
    resolved = 'status';
  } else if (DKG_SIGNAL.test(prompt) || domainIntent || explicitNames.length > 0
    || (options.hasPriorEvidence && FOLLOW_UP_SIGNAL.test(prompt))) {
    resolved = 'read';
  } else {
    resolved = 'chat';
  }

  if (resolved === 'chat') {
    return { profile: resolved, tools: [], reason: 'No DKG intent was detected.', writeBlocked: false };
  }

  const additional = options.additionalToolNames ?? [];
  let desired: string[];
  if (resolved === 'status') desired = [...STATUS_TOOL_NAMES];
  else if (resolved === 'catalog') desired = [...CATALOG_TOOL_NAMES];
  else if (resolved === 'read') {
    desired = [
      ...explicitNames,
      ...(domainIntent ? options.additionalReadToolNames ?? [] : []),
      ...namesForReadPrompt(prompt),
      ...additional,
      ...(!domainIntent ? options.additionalReadToolNames ?? [] : []),
    ];
  } else {
    desired = [
      ...explicitNames,
      ...(domainIntent ? options.additionalWriteToolNames ?? [] : []),
      ...namesForWritePrompt(prompt),
      ...additional,
      ...(options.additionalReadToolNames ?? []),
      ...(!domainIntent ? options.additionalWriteToolNames ?? [] : []),
    ];
  }

  const unique = [...new Set(desired)];
  let tools = selectByNames(options.tools, unique, maxTools);
  tools = tools.filter((tool) => (allowWrite && resolved === 'write') || !isMutatingTool(tool));

  return {
    profile: resolved,
    tools,
    reason: `${resolved} profile selected from the prompt; ${tools.length} schema(s) fit the tool budget.`,
    writeBlocked: false,
  };
}
