import path from 'node:path';
import process from 'node:process';
import {
  createDkgLocalLlmRuntimeSession,
  type DkgLocalLlmRuntimeSession,
  type DkgLocalLlmRuntimeSessionOptions,
} from '../local-llm-runtime-factory.js';

export const DKG_LOCAL_LLM_UI_SESSION_ID = 'local-llm:dkg-ui';

// Security allowlist for the daemon-owned, single-Context-Graph UI session.
// Each entry is backed by a tool implementation that scopes every read to its
// project argument. Do not infer this property from JSON Schema: some tools
// accept projectId while intentionally fanning out to other graphs.
const DKG_LOCAL_LLM_STRICT_PROJECT_TOOLS = [
  'dkg_sub_graph_list',
  'dkg_query',
  'dkg_get_entity',
  'dkg_get_entity_sources',
  'dkg_list_activity',
  'dkg_get_agent',
  'dkg_knowledge_asset_query',
  'dkg_knowledge_asset_history',
  'dkg_knowledge_asset_import_artifact_resolve',
  'dkg_knowledge_asset_import_artifact_read_markdown',
  'dkg_query_catalog_list',
  'dkg_query_catalog_run',
] as const;

export type LocalLlmErrorCode =
  | 'LOCAL_LLM_OFFLINE'
  | 'LOCAL_LLM_BUSY'
  | 'LOCAL_LLM_PROJECT_MISMATCH'
  | 'LOCAL_LLM_INVALID_REQUEST'
  | 'LOCAL_LLM_RUNTIME_ERROR';

export class DaemonLocalLlmError extends Error {
  constructor(
    readonly code: LocalLlmErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonLocalLlmError';
  }
}

export interface DaemonLocalLlmHealth {
  ok: boolean;
  ready: boolean;
  reachable: boolean;
  offline: boolean;
  busy: boolean;
  initialized: boolean;
  readOnly: true;
  sessionId: string;
  contextGraphId?: string;
  traceFile?: string;
  error?: string;
  initFailure?: string;
}

export interface DaemonLocalLlmChatResult {
  text: string;
  sessionId: string;
  contextGraphId?: string;
  profile: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  traceFile?: string;
  readOnly: true;
}

export interface DaemonLocalLlmService {
  health(): Promise<DaemonLocalLlmHealth>;
  chat(input: {
    message: string;
    contextGraphId?: string;
    signal?: AbortSignal;
  }): Promise<DaemonLocalLlmChatResult>;
  clear(): Promise<{ ok: true; sessionId: string; readOnly: true }>;
  close(): Promise<void>;
}

type SessionFactory = (
  options: DkgLocalLlmRuntimeSessionOptions,
) => Promise<DkgLocalLlmRuntimeSession>;

export interface DaemonLocalLlmServiceOptions {
  dkgHome: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetch?: typeof fetch;
  createSession?: SessionFactory;
  probeTimeoutMs?: number;
  stderr?: (line: string) => void;
}

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export function resolveDaemonLocalLlmSettings(
  dkgHome: string,
  env: NodeJS.ProcessEnv = process.env,
): { llamaUrl: string; model: string; defaultProjectId?: string; logDir: string } {
  return {
    llamaUrl: trimmed(env.DKG_LLM_URL)
      ?? trimmed(env.LLAMA_URL)
      ?? 'http://127.0.0.1:8080/v1/chat/completions',
    model: trimmed(env.DKG_LLM_MODEL) ?? trimmed(env.LLAMA_MODEL) ?? 'local-model',
    defaultProjectId: trimmed(env.DKG_PROJECT),
    logDir: path.join(dkgHome, 'logs', 'local-llm'),
  };
}

export function localLlmHealthUrl(llamaUrl: string): string {
  const url = new URL(llamaUrl);
  url.pathname = '/health';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDaemonLocalLlmService(
  options: DaemonLocalLlmServiceOptions,
): DaemonLocalLlmService {
  const settings = resolveDaemonLocalLlmSettings(options.dkgHome, options.env);
  const fetcher = options.fetch ?? globalThis.fetch;
  const createSession = options.createSession ?? createDkgLocalLlmRuntimeSession;
  const probeTimeoutMs = options.probeTimeoutMs ?? 2_000;
  let session: DkgLocalLlmRuntimeSession | undefined;
  let lockedProjectId: string | undefined;
  let hasProjectLock = false;
  let busy = false;
  let closed = false;
  let activeTurnController: AbortController | undefined;
  let activeTurnSettlement: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let initFailure: string | undefined;

  const probe = async (): Promise<{ reachable: boolean; error?: string }> => {
    try {
      const response = await fetcher(localLlmHealthUrl(settings.llamaUrl), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      if (response.ok) return { reachable: true };
      return { reachable: false, error: `llama.cpp health returned HTTP ${response.status}` };
    } catch (error) {
      return { reachable: false, error: `Local llama.cpp server is offline: ${errorMessage(error)}` };
    }
  };

  const closeSession = async (clearHistory: boolean): Promise<void> => {
    const current = session;
    session = undefined;
    if (!current) return;
    if (clearHistory) await current.runtime.clearSession().catch(() => undefined);
    await current.close();
  };

  return {
    async health() {
      const availability = await probe();
      const ready = availability.reachable && !initFailure && !closed;
      return {
        ok: ready,
        ready,
        reachable: availability.reachable,
        offline: !availability.reachable,
        busy,
        initialized: Boolean(session),
        readOnly: true,
        sessionId: DKG_LOCAL_LLM_UI_SESSION_ID,
        ...(hasProjectLock && lockedProjectId ? { contextGraphId: lockedProjectId } : {}),
        ...(session?.trace.filePath ? { traceFile: session.trace.filePath } : {}),
        ...(availability.error || initFailure ? { error: availability.error ?? initFailure } : {}),
        ...(initFailure ? { initFailure } : {}),
      };
    },

    async chat(input) {
      input.signal?.throwIfAborted();
      const message = input.message.trim();
      if (!message) {
        throw new DaemonLocalLlmError(
          'LOCAL_LLM_INVALID_REQUEST',
          400,
          'A non-empty "message" is required.',
        );
      }
      if (closed) {
        throw new DaemonLocalLlmError(
          'LOCAL_LLM_RUNTIME_ERROR',
          503,
          'The local LLM service is shutting down.',
        );
      }
      if (busy) {
        throw new DaemonLocalLlmError(
          'LOCAL_LLM_BUSY',
          409,
          'The local LLM session already has a turn in progress.',
        );
      }

      const requestedProjectId = trimmed(input.contextGraphId) ?? settings.defaultProjectId;
      if (hasProjectLock && requestedProjectId !== lockedProjectId) {
        throw new DaemonLocalLlmError(
          'LOCAL_LLM_PROJECT_MISMATCH',
          409,
          `This session is bound to Context Graph ${lockedProjectId ?? '<none>'}. Clear the session before using ${requestedProjectId ?? '<none>'}.`,
        );
      }

      const turnController = new AbortController();
      const signal = input.signal
        ? AbortSignal.any([input.signal, turnController.signal])
        : turnController.signal;
      let settleTurn!: () => void;
      const turnSettlement = new Promise<void>((resolve) => { settleTurn = resolve; });
      activeTurnController = turnController;
      activeTurnSettlement = turnSettlement;
      busy = true;
      try {
        const availability = await probe();
        signal.throwIfAborted();
        if (!availability.reachable) {
          throw new DaemonLocalLlmError(
            'LOCAL_LLM_OFFLINE',
            503,
            availability.error ?? 'The local llama.cpp server is offline.',
          );
        }
        if (!session) {
          try {
            const created = await createSession({
              dkgHome: options.dkgHome,
              llamaUrl: settings.llamaUrl,
              model: settings.model,
              projectId: requestedProjectId,
              strictProjectScope: true,
              strictProjectScopeTools: DKG_LOCAL_LLM_STRICT_PROJECT_TOOLS,
              strictProjectScopeUnscopedTools: ['dkg_status'],
              profile: 'auto',
              allowWrite: false,
              logDir: settings.logDir,
              maxToolCalls: 4,
              maxToolsPerTurn: 8,
              maxToolJsonBytes: 18_000,
              maxEvidenceChars: 12_000,
              maxSessionTurns: 6,
              maxSessionChars: 8_000,
              requestTimeoutMs: 120_000,
              temperature: 0.15,
              topP: 0.9,
              maxTokens: 1_024,
              cwd: options.cwd,
              stderr: options.stderr,
            });
            if (signal.aborted) {
              await created.close();
              signal.throwIfAborted();
            }
            if (closed) {
              await created.close();
              throw new DaemonLocalLlmError(
                'LOCAL_LLM_RUNTIME_ERROR',
                503,
                'The local LLM service is shutting down.',
              );
            }
            session = created;
            lockedProjectId = requestedProjectId;
            hasProjectLock = true;
            initFailure = undefined;
          } catch (error) {
            if (error instanceof DaemonLocalLlmError) throw error;
            if (signal.aborted) signal.throwIfAborted();
            initFailure = errorMessage(error);
            throw new DaemonLocalLlmError(
              'LOCAL_LLM_RUNTIME_ERROR',
              500,
              `Failed to initialize the local DKG LLM runtime: ${initFailure}`,
            );
          }
        }

        try {
          const result = await session.runtime.run(message, { signal });
          signal.throwIfAborted();
          return {
            text: result.answer,
            sessionId: DKG_LOCAL_LLM_UI_SESSION_ID,
            ...(lockedProjectId ? { contextGraphId: lockedProjectId } : {}),
            profile: result.profile,
            toolCalls: result.toolCalls,
            traceFile: result.traceFile ?? session.trace.filePath,
            readOnly: true,
          };
        } catch (error) {
          if (error instanceof DaemonLocalLlmError) throw error;
          if (signal.aborted) signal.throwIfAborted();
          const availabilityAfterFailure = await probe();
          if (!availabilityAfterFailure.reachable) {
            throw new DaemonLocalLlmError(
              'LOCAL_LLM_OFFLINE',
              503,
              availabilityAfterFailure.error ?? 'The local llama.cpp server is offline.',
            );
          }
          throw new DaemonLocalLlmError(
            'LOCAL_LLM_RUNTIME_ERROR',
            502,
            errorMessage(error),
          );
        }
      } finally {
        busy = false;
        settleTurn();
        if (activeTurnSettlement === turnSettlement) {
          activeTurnSettlement = undefined;
          activeTurnController = undefined;
        }
      }
    },

    async clear() {
      if (busy) {
        throw new DaemonLocalLlmError(
          'LOCAL_LLM_BUSY',
          409,
          'Wait for the active local LLM turn before clearing the session.',
        );
      }
      await closeSession(true);
      lockedProjectId = undefined;
      hasProjectLock = false;
      initFailure = undefined;
      return { ok: true, sessionId: DKG_LOCAL_LLM_UI_SESSION_ID, readOnly: true };
    },

    async close() {
      if (!closePromise) {
        closed = true;
        const pendingTurn = activeTurnSettlement;
        activeTurnController?.abort(new Error('The local LLM service is shutting down.'));
        closePromise = (async () => {
          await pendingTurn;
          await closeSession(false);
        })();
      }
      await closePromise;
    },
  };
}
