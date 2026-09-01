import {
  normalizeToolForLlama,
  parseAndValidateToolArguments,
  stableJson,
  toOpenAiTool,
  type McpToolDefinition,
  type OpenAiToolDefinition,
} from './schema.js';
import { dkgLocalLlmSystemContext } from './system-context.js';
import {
  createToolRouter,
  isMutatingTool,
  type ToolProfile,
} from './tool-router.js';
import { NOOP_TRACE, type InteractionTrace } from './text-trace.js';
import type { DkgLocalLlmDomainProfile } from './domain-profile.js';
import {
  rewriteCompactPredicatesForDkg,
  referencesUnresolvedContextGraphAlias,
  sanitizeContextGraphArguments,
  sanitizeDkgToolForLocalLlm,
  validateDkgToolCall,
} from './dkg-tool-validation.js';

export interface McpClientLike {
  listTools(options?: { signal?: AbortSignal }): Promise<{ tools: McpToolDefinition[] }>;
  callTool(input: {
    name: string;
    arguments?: Record<string, unknown>;
  }, options?: {
    signal?: AbortSignal;
  }): Promise<{
    isError?: boolean;
    content?: unknown[];
    structuredContent?: unknown;
  }>;
}

type ToolCall = {
  id?: string;
  type?: string;
  function: {
    name: string;
    arguments?: unknown;
  };
};

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

type OpenAiCompatibleResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
  [key: string]: unknown;
};

export interface DkgLocalLlmOptions {
  mcp: McpClientLike;
  fetch?: typeof fetch;
  llamaUrl?: string;
  model?: string;
  projectId?: string;
  /** Cancellation for MCP tool discovery during runtime construction. */
  initializationSignal?: AbortSignal;
  /**
   * Enforce projectId as a security boundary instead of a missing-argument
   * default. Used by daemon-owned UI sessions; the interactive CLI keeps its
   * evidence-driven cross-graph behavior unless this is explicitly enabled.
   */
  strictProjectScope?: boolean;
  /**
   * Explicitly trusted tools whose implementations are known to read only the
   * requested project. A schema field alone is not proof of single-graph
   * behavior (for example, dkg_memory_search also fans out to agent-context).
   */
  strictProjectScopeTools?: string[];
  /** Unscoped node-level reads that remain visible in strict project mode. */
  strictProjectScopeUnscopedTools?: string[];
  profile?: ToolProfile;
  allowWrite?: boolean;
  additionalToolNames?: string[];
  domainProfile?: DkgLocalLlmDomainProfile;
  systemContextAddendum?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  maxToolCalls?: number;
  maxToolsPerTurn?: number;
  maxToolJsonBytes?: number;
  maxEvidenceChars?: number;
  maxSessionTurns?: number;
  maxSessionChars?: number;
  requestTimeoutMs?: number;
  trace?: InteractionTrace;
}

export interface DkgLocalLlmRunOptions {
  signal?: AbortSignal;
}

export interface DkgLocalLlmResult {
  answer: string;
  profile: Exclude<ToolProfile, 'auto'>;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  traceFile?: string;
}

export interface DkgChatEvidence {
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  catalogScope?: {
    projectId: string;
    selectors: string[];
  };
}

export interface DkgChatTurn {
  turn: number;
  user: string;
  assistant: string;
  evidence: DkgChatEvidence[];
}

export interface DkgChatSessionInfo {
  turns: number;
  maxTurns: number;
  maxChars: number;
}

const ARGUMENT_ERROR = /\b(argument|invalid|validation|schema|required|unexpected)\b/i;
const EMPTY_DKG_QUERY_RESULT = /^(?:\(no results\)|false)$/i;
const SESSION_CONTEXT = `BOUNDED CHAT SESSION
Prior turns below only resolve conversational references. They are not current DKG evidence.
For a DKG follow-up, call an available read tool and ground the new answer in its result.`;

function positiveIntegerOption(label: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return resolved;
}

function compactText(value: string, limit: number): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  const marker = `\n...[${text.length - limit} chars omitted]...\n`;
  const available = Math.max(0, limit - marker.length);
  const headLength = Math.ceil(available * 0.6);
  const tailLength = Math.max(0, available - headLength);
  return `${text.slice(0, headLength)}${marker}${tailLength ? text.slice(-tailLength) : ''}`;
}

function cloneTurn(turn: DkgChatTurn): DkgChatTurn {
  return {
    turn: turn.turn,
    user: turn.user,
    assistant: turn.assistant,
    evidence: turn.evidence.map((item) => ({
      name: item.name,
      arguments: { ...item.arguments },
      result: item.result,
      ...(item.catalogScope ? {
        catalogScope: {
          projectId: item.catalogScope.projectId,
          selectors: [...item.catalogScope.selectors],
        },
      } : {}),
    })),
  };
}

function renderSessionTurn(turn: DkgChatTurn): string {
  const evidence = turn.evidence.length
    ? turn.evidence.map((item) => `- ${item.name} ${stableJson(item.arguments)}\n${item.result}`).join('\n')
    : '- none';
  return [
    `TURN ${turn.turn}`,
    `User: ${turn.user}`,
    `Assistant: ${turn.assistant}`,
    `Prior evidence reference:\n${evidence}`,
  ].join('\n');
}

function toolResultText(result: { content?: unknown[] }): string {
  return (result.content ?? [])
    .map((item) => {
      if (item && typeof item === 'object' && 'text' in item) {
        return String((item as { text?: unknown }).text ?? '');
      }
      return JSON.stringify(item);
    })
    .filter(Boolean)
    .join('\n');
}

function toolContextGraphArguments(
  tool: McpToolDefinition,
): Array<'projectId' | 'contextGraphId'> {
  const properties = tool.inputSchema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  return (['projectId', 'contextGraphId'] as const)
    .filter((argument) => Object.hasOwn(properties, argument));
}

function structuredEvidence(value: string): Record<string, unknown> | undefined {
  const marker = 'Structured DKG evidence (authoritative):';
  const markerIndex = value.indexOf(marker);
  if (markerIndex < 0) return undefined;
  try {
    const parsed = JSON.parse(value.slice(markerIndex + marker.length).trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function catalogEvidenceMatchesSelector(evidence: DkgChatEvidence, selector: string): string | undefined {
  if (evidence.name !== 'dkg_query_catalog_list') return undefined;
  if (evidence.catalogScope?.selectors.includes(selector)) return evidence.catalogScope.projectId;
  const structured = structuredEvidence(evidence.result);
  const items = Array.isArray(structured?.items) ? structured.items : [];
  const matches = items.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return [record.selector, record.slug, record.name].some((value) => value === selector);
  });
  if (!matches) return undefined;
  const structuredProjectId = typeof structured?.contextGraphId === 'string'
    ? structured.contextGraphId.trim()
    : '';
  const argumentProjectId = typeof evidence.arguments.projectId === 'string'
    ? evidence.arguments.projectId.trim()
    : '';
  return structuredProjectId || argumentProjectId || undefined;
}

function catalogScopeFromResult(
  toolName: string,
  args: Record<string, unknown>,
  value: unknown,
): DkgChatEvidence['catalogScope'] {
  if (toolName !== 'dkg_query_catalog_list' || !value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const structured = value as Record<string, unknown>;
  const projectId = typeof structured.contextGraphId === 'string'
    ? structured.contextGraphId.trim()
    : typeof args.projectId === 'string'
      ? args.projectId.trim()
      : '';
  if (!projectId || !Array.isArray(structured.items)) return undefined;
  const selectors = [...new Set(structured.items.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    return [record.selector, record.slug, record.name]
      .filter((selector): selector is string => typeof selector === 'string' && Boolean(selector.trim()))
      .map((selector) => selector.trim());
  }))];
  return selectors.length ? { projectId, selectors } : undefined;
}

function toolCallSignature(toolCall: ToolCall): string {
  let args: unknown = toolCall.function.arguments ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args || '{}');
    } catch {
      // Keep malformed JSON verbatim so an unchanged retry is detectable.
    }
  }
  return `${toolCall.function.name}:${stableJson(args)}`;
}

function assistantToolMessage(toolCall: ToolCall): ChatMessage {
  return {
    role: 'assistant',
    tool_calls: [{
      id: toolCall.id,
      type: toolCall.type ?? 'function',
      function: {
        name: toolCall.function.name,
        arguments: typeof toolCall.function.arguments === 'string'
          ? toolCall.function.arguments
          : JSON.stringify(toolCall.function.arguments ?? {}),
      },
    }],
  };
}

export function normalizeFinalAnswer(value: string): string {
  const withoutControls = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return !(
        codePoint <= 0x08
        || codePoint === 0x0b
        || codePoint === 0x0c
        || (codePoint >= 0x0e && codePoint <= 0x1f)
        || codePoint === 0x7f
        || (codePoint >= 0x200b && codePoint <= 0x200d)
        || codePoint === 0x2060
        || codePoint === 0xfeff
      );
    })
    .join('');
  return withoutControls
    .replace(/<\|[^|>]{1,80}\|>/g, '')
    .split('\n')
    .filter((line) => !/^\s*[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\s]{2,}\s*$/u.test(line))
    .join('\n')
    .trim();
}

export class DkgLocalLlmRuntime {
  private readonly mcp: McpClientLike;
  private readonly fetcher: typeof fetch;
  private readonly llamaUrl: string;
  private readonly model: string;
  private readonly projectId?: string;
  private readonly strictProjectScope: boolean;
  private readonly strictProjectScopeTools: Set<string>;
  private readonly strictProjectScopeUnscopedTools: Set<string>;
  private readonly profile: ToolProfile;
  private readonly allowWrite: boolean;
  private readonly additionalToolNames: string[];
  private readonly domainProfile?: DkgLocalLlmDomainProfile;
  private readonly systemContextAddendum?: string;
  private readonly temperature: number;
  private readonly topP: number;
  private readonly maxTokens: number;
  private readonly maxToolCalls: number;
  private readonly maxToolsPerTurn: number;
  private readonly maxToolJsonBytes: number;
  private readonly maxEvidenceChars: number;
  private readonly maxSessionTurns: number;
  private readonly maxSessionChars: number;
  private readonly requestTimeoutMs: number;
  private readonly trace: InteractionTrace;
  private readonly tools: McpToolDefinition[];
  private readonly toolRouter: ReturnType<typeof createToolRouter>;
  private sessionTurns: DkgChatTurn[] = [];
  private sessionTurnCounter = 0;

  private constructor(options: DkgLocalLlmOptions, tools: McpToolDefinition[]) {
    this.mcp = options.mcp;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.llamaUrl = options.llamaUrl ?? 'http://127.0.0.1:8080/v1/chat/completions';
    this.model = options.model ?? 'local-model';
    this.projectId = options.projectId?.trim() || undefined;
    this.strictProjectScope = options.strictProjectScope ?? false;
    this.strictProjectScopeTools = new Set(
      options.strictProjectScopeTools?.map((name) => name.trim()).filter(Boolean) ?? [],
    );
    this.strictProjectScopeUnscopedTools = new Set(
      options.strictProjectScopeUnscopedTools?.map((name) => name.trim()).filter(Boolean) ?? [],
    );
    this.profile = options.profile ?? 'auto';
    this.allowWrite = options.allowWrite ?? false;
    this.additionalToolNames = [...new Set(options.additionalToolNames ?? [])];
    this.domainProfile = options.domainProfile;
    this.systemContextAddendum = options.systemContextAddendum?.trim() || undefined;
    this.temperature = options.temperature ?? 0.15;
    this.topP = options.topP ?? 0.9;
    this.maxTokens = positiveIntegerOption('maxTokens', options.maxTokens, 1_024);
    this.maxToolCalls = positiveIntegerOption('maxToolCalls', options.maxToolCalls, 4);
    this.maxToolsPerTurn = positiveIntegerOption('maxToolsPerTurn', options.maxToolsPerTurn, 8);
    this.maxToolJsonBytes = positiveIntegerOption('maxToolJsonBytes', options.maxToolJsonBytes, 18_000);
    this.maxEvidenceChars = positiveIntegerOption('maxEvidenceChars', options.maxEvidenceChars, 12_000);
    this.maxSessionTurns = positiveIntegerOption('maxSessionTurns', options.maxSessionTurns, 6);
    this.maxSessionChars = positiveIntegerOption('maxSessionChars', options.maxSessionChars, 8_000);
    this.requestTimeoutMs = positiveIntegerOption('requestTimeoutMs', options.requestTimeoutMs, 120_000);
    this.trace = options.trace ?? NOOP_TRACE;
    this.tools = this.strictProjectScope
      ? tools.filter((tool) => {
          const graphArguments = toolContextGraphArguments(tool);
          if (this.strictProjectScopeTools.has(tool.name)) {
            return Boolean(this.projectId) && graphArguments.length > 0;
          }
          return graphArguments.length === 0
            && this.strictProjectScopeUnscopedTools.has(tool.name);
        })
      : tools;
    if (!this.tools.length) {
      throw new Error('MCP tools/list returned no tools compatible with the strict Context Graph scope.');
    }
    this.toolRouter = createToolRouter(this.tools);
  }

  static async create(options: DkgLocalLlmOptions): Promise<DkgLocalLlmRuntime> {
    options.initializationSignal?.throwIfAborted();
    const listed = await options.mcp.listTools({ signal: options.initializationSignal });
    options.initializationSignal?.throwIfAborted();
    const tools: McpToolDefinition[] = [];
    const rejected: Array<{ name: string; error: string }> = [];
    const normalizations: Array<{ name: string; changes: string[] }> = [];
    for (const rawTool of listed.tools) {
      try {
        const normalized = normalizeToolForLlama(rawTool);
        tools.push(sanitizeDkgToolForLocalLlm(normalized.tool));
        if (normalized.changes.length) {
          normalizations.push({ name: rawTool.name, changes: normalized.changes });
        }
      } catch (error) {
        rejected.push({
          name: rawTool.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!tools.length) throw new Error('MCP tools/list returned no llama.cpp-compatible tools.');

    const runtime = new DkgLocalLlmRuntime(options, tools);
    await runtime.trace.write('MCP TOOLS/LIST', {
      discovered: listed.tools.length,
      compatible: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        annotations: tool.annotations,
        inputSchema: tool.inputSchema,
      })),
      schemaNormalizations: normalizations,
      rejected,
    });
    return runtime;
  }

  getAvailableToolNames(): string[] {
    return this.tools.map((tool) => tool.name);
  }

  getSessionHistory(): DkgChatTurn[] {
    return this.sessionTurns.map(cloneTurn);
  }

  getSessionInfo(): DkgChatSessionInfo {
    return {
      turns: this.sessionTurns.length,
      maxTurns: this.maxSessionTurns,
      maxChars: this.maxSessionChars,
    };
  }

  async clearSession(): Promise<void> {
    const removedTurns = this.sessionTurns.length;
    this.sessionTurns = [];
    this.sessionTurnCounter = 0;
    await this.trace.write('SESSION CLEARED', { removedTurns });
  }

  private renderSessionContext(): string {
    if (!this.sessionTurns.length) return '';
    const selected = this.sessionTurns.slice(-this.maxSessionTurns);
    while (selected.length > 1) {
      const rendered = selected.map(renderSessionTurn).join('\n\n');
      if (rendered.length <= this.maxSessionChars) return rendered;
      selected.shift();
    }
    return compactText(selected.map(renderSessionTurn).join('\n\n'), this.maxSessionChars);
  }

  private async rememberTurn(
    user: string,
    assistant: string,
    evidence: DkgChatEvidence[],
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const nextTurn = this.sessionTurnCounter + 1;
    const perField = Math.max(500, Math.floor(this.maxSessionChars / 3));
    const turn: DkgChatTurn = {
      turn: nextTurn,
      user: compactText(user, perField),
      assistant: compactText(assistant, perField),
      evidence: evidence.map((item) => ({
        name: item.name,
        arguments: { ...item.arguments },
        result: compactText(item.result, Math.min(2_000, perField)),
        ...(item.catalogScope ? {
          catalogScope: {
            projectId: item.catalogScope.projectId,
            selectors: [...item.catalogScope.selectors],
          },
        } : {}),
      })),
    };
    const droppedTurns = Math.max(0, this.sessionTurns.length + 1 - this.maxSessionTurns);
    await this.trace.write('SESSION TURN SAVED', {
      turn: turn.turn,
      retainedTurns: Math.min(this.sessionTurns.length + 1, this.maxSessionTurns),
      droppedTurns,
      evidence: turn.evidence.map((item) => ({ name: item.name, arguments: item.arguments })),
    });
    signal?.throwIfAborted();
    this.sessionTurnCounter = nextTurn;
    this.sessionTurns.push(turn);
    if (droppedTurns) this.sessionTurns.splice(0, droppedTurns);
  }

  private catalogEvidenceProjectId(
    toolName: string,
    args: Record<string, unknown>,
    currentEvidence: DkgChatEvidence[],
  ): string | undefined {
    if (toolName !== 'dkg_query_catalog_run' || typeof args.selector !== 'string') return undefined;
    const selector = args.selector.trim();
    if (!selector) return undefined;
    const evidenceNewestFirst = [
      ...[...currentEvidence].reverse(),
      ...[...this.sessionTurns].reverse().flatMap((turn) => [...turn.evidence].reverse()),
    ];
    for (const evidence of evidenceNewestFirst) {
      const projectId = catalogEvidenceMatchesSelector(evidence, selector);
      if (projectId) return projectId;
    }
    return undefined;
  }

  private async callModel(
    messages: ChatMessage[],
    tools: OpenAiToolDefinition[],
    toolChoice: 'required' | 'auto' | undefined,
    round: number,
    maxTokens = this.maxTokens,
    signal?: AbortSignal,
  ): Promise<OpenAiCompatibleResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: this.temperature,
      top_p: this.topP,
      max_tokens: maxTokens,
      parallel_tool_calls: false,
      reasoning_effort: 'none',
      chat_template_kwargs: { enable_thinking: false },
    };
    if (tools.length) body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;

    await this.trace.write(`LLM REQUEST ${round}`, { endpoint: this.llamaUrl, body });
    signal?.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const response = await this.fetcher(this.llamaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    const raw = await response.text();
    signal?.throwIfAborted();
    if (!response.ok) {
      await this.trace.write(`LLM HTTP ERROR ${round}`, { status: response.status, body: raw });
      throw new Error(`Local LLM endpoint returned ${response.status}: ${raw}`);
    }

    let parsed: OpenAiCompatibleResponse;
    try {
      parsed = JSON.parse(raw) as OpenAiCompatibleResponse;
    } catch (error) {
      throw new Error(`Local LLM endpoint returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.trace.write(`LLM RESPONSE ${round}`, parsed);
    return parsed;
  }

  async run(
    userPrompt: string,
    options: DkgLocalLlmRunOptions = {},
  ): Promise<DkgLocalLlmResult> {
    const { signal } = options;
    signal?.throwIfAborted();
    const prompt = userPrompt.trim();
    if (!prompt) throw new Error('A non-empty user prompt is required.');
    if (!this.projectId && referencesUnresolvedContextGraphAlias(prompt)) {
      throw new Error(
        'No Session Context Graph is selected, so "default/current Context Graph" is unresolved in local LLM mode. '
        + 'Name the exact graph id in the request or restart with --project <id>; MCP configuration defaults are intentionally ignored.',
      );
    }

    const route = this.toolRouter({
      prompt,
      profile: this.profile,
      allowWrite: this.allowWrite,
      maxTools: this.maxToolsPerTurn,
      maxJsonBytes: this.maxToolJsonBytes,
      additionalToolNames: this.additionalToolNames,
      additionalReadToolNames: this.domainProfile?.readTools,
      additionalWriteToolNames: this.domainProfile?.writeTools,
      domainKeywords: this.domainProfile?.routingKeywords,
      hasPriorEvidence: this.sessionTurns.some((turn) => turn.evidence.length > 0),
    });
    await this.trace.write('TOOL ROUTER', {
      domainProfile: this.domainProfile?.name,
      profile: route.profile,
      reason: route.reason,
      writeBlocked: route.writeBlocked,
      jsonBytes: route.jsonBytes,
      exposedTools: route.tools.map((tool) => tool.name),
      ranking: route.rankedTools,
    });
    if (route.writeBlocked) {
      throw new Error('The prompt requests a DKG mutation, but this runtime is read-only. Restart with allowWrite enabled.');
    }
    if (route.profile !== 'chat' && !route.tools.length) {
      throw new Error(`The MCP server exposes no compatible tools for the '${route.profile}' profile.`);
    }

    const priorSession = this.renderSessionContext();
    const systemContext = [
      dkgLocalLlmSystemContext({
        projectId: this.projectId,
        profile: route.profile,
        toolNames: route.tools.map((tool) => tool.name),
        allowWrite: this.allowWrite,
        addendum: [this.domainProfile?.systemContext, this.systemContextAddendum]
          .filter(Boolean)
          .join('\n\n'),
      }),
      ...(priorSession ? [SESSION_CONTEXT, priorSession] : []),
    ].join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: systemContext },
      { role: 'user', content: prompt },
    ];
    await this.trace.write('SYSTEM CONTEXT', systemContext);
    await this.trace.write('USER', prompt);

    const availableByName = new Map(route.tools.map((tool) => [tool.name, tool]));
    const openAiTools = route.tools.map(toOpenAiTool);
    const successfulSignatures = new Set<string>();
    const executed: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const sessionEvidence: DkgChatEvidence[] = [];
    let repairUsed = false;
    let previousFailedSignature: string | undefined;
    let pinnedToolName: string | undefined;
    let requireTool = route.profile !== 'chat';
    let finalOnly = false;
    let truncationRetryUsed = false;

    const scheduleRepair = async (
      reason: string,
      signature: string,
      toolName?: string,
      options: { requireTool?: boolean; instruction?: string } = {},
    ) => {
      if (repairUsed) throw new Error(`${reason} One-retry limit reached.`);
      repairUsed = true;
      previousFailedSignature = signature;
      pinnedToolName = toolName;
      requireTool = options.requireTool ?? true;
      messages.push({
        role: 'user',
        content: options.instruction ?? (toolName
          ? `${reason} Retry ${toolName} once with changed arguments that exactly match its schema.`
          : `${reason} Retry once with exactly one available tool call and no prose.`),
      });
      await this.trace.write('RETRY SCHEDULED', {
        reason,
        signature,
        pinnedToolName,
        requireTool,
      });
    };

    for (let round = 1; round <= this.maxToolCalls + 4; round++) {
      signal?.throwIfAborted();
      const routedTools = finalOnly
        ? []
        : pinnedToolName
          ? openAiTools.filter((tool) => tool.function.name === pinnedToolName)
          : executed.length >= this.maxToolCalls
            ? []
            : openAiTools;
      const toolChoice = routedTools.length ? (requireTool ? 'required' : 'auto') : undefined;
      const response = await this.callModel(
        messages,
        routedTools,
        toolChoice,
        round,
        route.profile === 'chat' ? Math.min(this.maxTokens, 256) : this.maxTokens,
        signal,
      );
      const choice = response.choices?.[0];
      const assistant = choice?.message;
      if (!assistant) throw new Error('Local LLM endpoint returned no assistant choice.');
      const toolCalls = assistant.tool_calls ?? [];

      if (toolCalls.length === 0) {
        if (requireTool) {
          await scheduleRepair('The model returned prose without the required DKG evidence call.', 'format:no-tool-call');
          continue;
        }
        if (choice.finish_reason === 'length') {
          if (truncationRetryUsed) throw new Error('The local model truncated the final answer twice. Increase maxTokens.');
          truncationRetryUsed = true;
          finalOnly = true;
          pinnedToolName = undefined;
          const retryTargetTokens = Math.max(64, Math.floor(this.maxTokens * 0.75));
          messages.push({
            role: 'user',
            content:
              'The previous final draft exceeded the output budget and was discarded. '
              + 'Answer again from existing tool evidence only, without another tool call. '
              + `The complete replacement must target fewer than ${retryTargetTokens} tokens. `
              + 'Preserve every distinct item the user requested. For lists, output only the minimum identifying fields; '
              + 'omit descriptions, commentary, repeated headings, and other optional detail.',
          });
          await this.trace.write('FINAL ANSWER TRUNCATION RETRY', {
            finishReason: choice.finish_reason,
            discardedDraftChars: String(assistant.content ?? '').length,
            retryTargetTokens,
          });
          continue;
        }
        const answer = normalizeFinalAnswer(String(assistant.content ?? ''));
        if (!answer) throw new Error('Local LLM endpoint returned an empty final answer.');
        await this.trace.write('FINAL ANSWER', answer);
        await this.rememberTurn(prompt, answer, sessionEvidence, signal);
        return { answer, profile: route.profile, toolCalls: executed, traceFile: this.trace.filePath };
      }

      if (!routedTools.length) {
        await scheduleRepair('The model requested a tool when tools were not available.', `format:${stableJson(toolCalls)}`);
        continue;
      }
      if (toolCalls.length !== 1) {
        await scheduleRepair(
          `The model returned ${toolCalls.length} tool calls; exactly one is allowed per round.`,
          `format:${stableJson(toolCalls)}`,
        );
        continue;
      }

      const toolCall = toolCalls[0];
      const signature = toolCallSignature(toolCall);
      if (previousFailedSignature && signature === previousFailedSignature) {
        throw new Error(`The retry repeated an unchanged failed tool call: ${signature}`);
      }
      const tool = availableByName.get(toolCall.function.name);
      if (!tool) {
        await scheduleRepair(`The model requested unavailable tool '${toolCall.function.name}'.`, signature);
        continue;
      }
      if (isMutatingTool(tool) && (!this.allowWrite || route.profile !== 'write')) {
        throw new Error(`Blocked mutation tool call outside an authorized write route: ${tool.name}`);
      }
      const parsed = parseAndValidateToolArguments(toolCall.function.arguments, tool);
      if (!parsed.ok) {
        await scheduleRepair(`Invalid arguments for ${tool.name}: ${parsed.error}`, signature, tool.name);
        continue;
      }
      const sanitized = sanitizeContextGraphArguments(parsed.args);
      parsed.args = sanitized.args;
      if (sanitized.removed.length) {
        await this.trace.write('INVALID CONTEXT GRAPH TARGET REMOVED', {
          tool: tool.name,
          reasons: sanitized.reasons,
        });
      }
      const graphArguments = toolContextGraphArguments(tool);
      const graphArgument = graphArguments[0];
      if (graphArguments.length && this.strictProjectScope) {
        if (!this.projectId) {
          throw new Error(`${tool.name} is unavailable without a strict session Context Graph.`);
        }
        const suppliedProjectIds = Object.fromEntries(
          graphArguments.map((argument) => [argument, parsed.args[argument]]),
        );
        for (const argument of graphArguments) parsed.args[argument] = this.projectId;
        if (graphArguments.some((argument) => suppliedProjectIds[argument] !== this.projectId)) {
          await this.trace.write('TOOL PROJECT SCOPE PINNED', {
            tool: tool.name,
            arguments: graphArguments,
            suppliedProjectIds,
            projectId: this.projectId,
          });
        }
      } else if (graphArgument && parsed.args[graphArgument] === undefined) {
        const evidenceProjectId = graphArgument === 'projectId'
          ? this.catalogEvidenceProjectId(tool.name, parsed.args, sessionEvidence)
          : undefined;
        const projectId = evidenceProjectId ?? this.projectId;
        if (!projectId) {
          throw new Error(
            `${tool.name} requires an explicit Context Graph in local LLM mode. `
            + (sanitized.removed.length
              ? `The model supplied ${sanitized.reasons.map((item) => `${item.key}=${JSON.stringify(item.value)} (${item.reason})`).join(', ')}, which is not a graph id. `
              : '')
            + 'Name the exact graph in the request or restart with --project <id>; MCP configuration defaults are not used.',
          );
        }
        parsed.args[graphArgument] = projectId;
        await this.trace.write('TOOL PROJECT SCOPE MATERIALIZED', {
          tool: tool.name,
          projectId,
          argument: graphArgument,
          source: evidenceProjectId ? 'catalog-evidence' : 'explicit-session-pin',
        });
      }
      const normalizedSignature = `${tool.name}:${stableJson(parsed.args)}`;
      const preflight = validateDkgToolCall(tool.name, parsed.args);
      if (!preflight.ok) {
        await scheduleRepair(
          `DKG preflight rejected ${tool.name}: ${preflight.errors.join('; ')}`,
          normalizedSignature,
          tool.name,
        );
        continue;
      }
      if (successfulSignatures.has(normalizedSignature)) {
        const nextMutation = route.profile === 'write'
          ? route.tools.find((candidate) =>
              isMutatingTool(candidate)
              && !executed.some((item) => item.name === candidate.name))
          : undefined;
        if (nextMutation) {
          await scheduleRepair(
            `The model repeated an already successful discovery call: ${normalizedSignature}`,
            normalizedSignature,
            nextMutation.name,
            {
              instruction:
                `Discovery already succeeded. The router selected ${nextMutation.name} as the relevant authorized mutation that has not run yet. `
                + `Call ${nextMutation.name} now with arguments from the user's request that exactly match its schema; do not repeat a discovery tool.`,
            },
          );
          continue;
        }
        await scheduleRepair(
          `The model repeated an already successful tool call: ${normalizedSignature}`,
          normalizedSignature,
          undefined,
          {
            requireTool: false,
            instruction:
              `The exact call ${normalizedSignature} already succeeded. Do not call it again with those arguments. `
              + `Already completed tool names: ${executed.map((item) => item.name).join(', ') || 'none'}. `
              + 'If the original request still needs work, call the requested next tool with valid arguments; otherwise answer now from the evidence already returned.',
          },
        );
        continue;
      }

      const callId = toolCall.id || `dkg-tool-${round}`;
      const cleanToolCall: ToolCall = {
        ...toolCall,
        id: callId,
        function: { ...toolCall.function, arguments: JSON.stringify(parsed.args) },
      };
      messages.push(assistantToolMessage(cleanToolCall));
      await this.trace.write(`TOOL CALL ${executed.length + 1}`, { name: tool.name, arguments: parsed.args });

      let result: Awaited<ReturnType<McpClientLike['callTool']>>;
      try {
        const input = { name: tool.name, arguments: parsed.args };
        result = signal
          ? await this.mcp.callTool(input, { signal })
          : await this.mcp.callTool(input);
      } catch (error) {
        signal?.throwIfAborted();
        result = {
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        };
      }
      await this.trace.write(`TOOL RESULT ${executed.length + 1}`, result);
      const resultText = toolResultText(result);
      if (result.isError) {
        // Preserve the OpenAI tool-call protocol before asking the model to
        // repair its arguments: every assistant tool_call must be followed by
        // a tool-role result with the matching id.
        messages.push({
          role: 'tool',
          tool_call_id: callId,
          content: JSON.stringify({
            isError: true,
            content: [{ type: 'text', text: compactText(resultText || 'unknown MCP error', this.maxEvidenceChars) }],
          }),
        });
        if (ARGUMENT_ERROR.test(resultText)) {
          await scheduleRepair(`MCP rejected arguments for ${tool.name}: ${resultText}`, signature, tool.name);
          continue;
        }
        throw new Error(`${tool.name} failed: ${resultText || 'unknown MCP error'}`);
      }

      const modelEvidence = result.structuredContent !== undefined
        ? `Structured DKG evidence (authoritative):\n${stableJson(result.structuredContent)}`
        : resultText;
      const compactEvidence = compactText(modelEvidence || stableJson(result.content ?? null), this.maxEvidenceChars);
      messages.push({
        role: 'tool',
        tool_call_id: callId,
        content: JSON.stringify({
          isError: false,
          content: [{ type: 'text', text: compactEvidence }],
        }),
      });
      successfulSignatures.add(normalizedSignature);
      executed.push({ name: tool.name, arguments: parsed.args });
      const catalogScope = catalogScopeFromResult(
        tool.name,
        parsed.args,
        result.structuredContent,
      );
      sessionEvidence.push({
        name: tool.name,
        arguments: parsed.args,
        result: compactEvidence,
        ...(catalogScope ? { catalogScope } : {}),
      });
      const originalSparql = String(parsed.args.sparql ?? '');
      const correctedSparql = rewriteCompactPredicatesForDkg(originalSparql);
      const queryNeedsStorageTermRetry = tool.name === 'dkg_query'
        && EMPTY_DKG_QUERY_RESULT.test(resultText.trim())
        && correctedSparql !== originalSparql;
      if (queryNeedsStorageTermRetry && !repairUsed) {
        const correctedArgs = {
          ...parsed.args,
          sparql: correctedSparql,
        };
        await scheduleRepair(
          `${tool.name} executed but returned ${JSON.stringify(resultText.trim())}. `
            + 'Retry once without changing the requested entities, literals, project, subgraph, or view. '
            + 'DKG quad writes preserve compact predicate strings: match a requested/stored rdf:type or schema:category as <rdf:type> or <schema:category>, rather than SPARQL shorthand or an expanded prefix.',
          normalizedSignature,
          tool.name,
          {
            instruction:
              `${tool.name} returned no matching evidence using expanded/shorthand predicates. `
              + `Retry exactly once with this storage-term-preserving argument object: ${stableJson(correctedArgs)}. `
              + 'Do not change the project, subgraph, view, entities, literals, variables, ordering, or limits.',
          },
        );
        continue;
      }
      previousFailedSignature = undefined;
      pinnedToolName = undefined;
      requireTool = false;
    }

    throw new Error('Maximum local-model orchestration rounds reached.');
  }
}
