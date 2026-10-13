import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { LOCAL_LLM_PROGRAM_TOOL, localLlmConfigurationSha256, localLlmAdapterHashes,
  type LocalLlmProgramCapability, type LocalLlmProgramProvider } from '../semantic-runtime-local-llm-adapter.js';
import { lstatSync, readFileSync } from 'node:fs';
import {
  probeLocalModelEndpoint,
  parseDomainProfile,
  type DkgLocalLlmDomainProfile,
  type LocalModelEndpointAvailability,
  type LocalModelEndpointProbeStrategy,
} from '@origintrail-official/dkg-local-llm';
import { createDkgLocalLlmRuntimeSession } from '../local-llm-runtime-factory.js';

import { createLocalLlmSessionOwner, DaemonLocalLlmError, type LocalLlmSessionFactory } from './local-llm-session.js';
export { DaemonLocalLlmError, type LocalLlmErrorCode } from './local-llm-session.js';

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

export interface DaemonLocalLlmHealth {
  ok: boolean;
  /** True when the operator supplied at least one local-LLM environment override. */
  configured: boolean;
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
  executionMode?: 'program' | 'direct';
  programCapability?: LocalLlmProgramCapability;
}

export interface LocalLlmProgramExecution {
  invocationId: string; executionIri: string; executionLayer: string;
  persisted: true; programIri: string; contextGraphId: string; assetName: string;
}

export interface DaemonLocalLlmChatResult {
  execution?: LocalLlmProgramExecution;
  text: string;
  sessionId: string;
  contextGraphId?: string;
  profile: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  traceFile?: string;
  readOnly: true;
}

export interface DaemonLocalLlmService {
  readonly programProvider?: LocalLlmProgramProvider;
  health(): Promise<DaemonLocalLlmHealth>;
  chat(input: {
    message: string;
    contextGraphId?: string;
    signal?: AbortSignal;
  }): Promise<DaemonLocalLlmChatResult>;
  clear(): Promise<{ ok: true; sessionId: string; readOnly: true }>;
  close(): Promise<void>;
}

export interface LocalLlmProgramExecutor {
  chat(input: { message: string; contextGraphId?: string; signal?: AbortSignal }):
    Promise<Omit<DaemonLocalLlmChatResult, 'sessionId' | 'readOnly'>>;
}

export interface DaemonLocalLlmServiceOptions {
  createProgramExecutor?: (options: { dkgHome: string; capability: LocalLlmProgramCapability }) => Promise<LocalLlmProgramExecutor>;
  dkgHome: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetch?: typeof fetch;
  createSession?: LocalLlmSessionFactory;
  probeStrategy?: LocalModelEndpointProbeStrategy;
  probeTimeoutMs?: number;
  stderr?: (line: string) => void;
}

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveProbeStrategy(value: string | undefined): {
  strategy: LocalModelEndpointProbeStrategy;
  error?: string;
} {
  const configured = trimmed(value)?.toLowerCase();
  if (!configured || configured === 'auto') return { strategy: { kind: 'auto' } };
  if (configured === 'ollama') return { strategy: { kind: 'ollama' } };
  if (['llama.cpp', 'llama-cpp', 'llamacpp'].includes(configured)) {
    return { strategy: { kind: 'llama.cpp' } };
  }
  return {
    strategy: { kind: 'auto' },
    error: `DKG_LLM_BACKEND must be one of: auto, ollama, llama.cpp (received '${value?.trim()}')`,
  };
}

export function resolveDaemonLocalLlmSettings(
  dkgHome: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  configured: boolean;
  llamaUrl: string;
  model: string;
  probeStrategy: LocalModelEndpointProbeStrategy;
  probeConfigurationError?: string;
  defaultProjectId?: string;
  logDir: string;
  adapterPaths?: string[];
  domainProfile?: DkgLocalLlmDomainProfile;
} {
  const probe = resolveProbeStrategy(env.DKG_LLM_BACKEND);
  let domainProfile: DkgLocalLlmDomainProfile | undefined;
  let adapterPaths: string[] | undefined;
  let domainError: string | undefined;
  try {
    const adapters = trimmed(env.DKG_LLM_ADAPTERS);
    if (adapters) {
      adapterPaths = adapters.split(',').map(value => value.trim()).filter(Boolean);
      if (adapterPaths.length > 16 || adapterPaths.some(value => !path.isAbsolute(value))) {
        throw new Error('DKG_LLM_ADAPTERS requires at most 16 absolute adapter paths.');
      }
    }
    const profilePath = trimmed(env.DKG_LLM_DOMAIN_PROFILE);
    if (profilePath) {
      if (!path.isAbsolute(profilePath)) throw new Error('DKG_LLM_DOMAIN_PROFILE requires an absolute path.');
      const info = lstatSync(profilePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 || (info.mode & 0o022)) {
        throw new Error('The daemon domain profile must be a bounded operator-owned file.');
      }
      domainProfile = parseDomainProfile(JSON.parse(readFileSync(profilePath, 'utf8')));
      if (domainProfile.writeTools?.length) throw new Error('Daemon domain profiles cannot enable write tools.');
    }
    if (adapterPaths?.length && !domainProfile) {
      throw new Error('DKG_LLM_ADAPTERS requires a reviewed DKG_LLM_DOMAIN_PROFILE.');
    }
  } catch (error) {
    domainError = errorMessage(error);
  }
  const configured = [
    env.DKG_LLM_URL,
    env.LLAMA_URL,
    env.DKG_LLM_MODEL,
    env.LLAMA_MODEL,
    env.DKG_LLM_BACKEND,
    env.DKG_LLM_ADAPTERS,
    env.DKG_LLM_DOMAIN_PROFILE,
  ].some((value) => trimmed(value) !== undefined);
  return {
    configured,
    llamaUrl: trimmed(env.DKG_LLM_URL)
      ?? trimmed(env.LLAMA_URL)
      ?? 'http://127.0.0.1:8080/v1/chat/completions',
    model: trimmed(env.DKG_LLM_MODEL) ?? trimmed(env.LLAMA_MODEL) ?? 'local-model',
    probeStrategy: probe.strategy,
    ...(probe.error || domainError ? { probeConfigurationError: probe.error ?? domainError } : {}),
    ...(adapterPaths ? { adapterPaths } : {}),
    ...(domainProfile ? { domainProfile } : {}),
    defaultProjectId: trimmed(env.DKG_PROJECT),
    logDir: path.join(dkgHome, 'logs', 'local-llm'),
  };
}

export function createDaemonLocalLlmService(
  options: DaemonLocalLlmServiceOptions,
): DaemonLocalLlmService {
  const settings = resolveDaemonLocalLlmSettings(options.dkgHome, options.env);
  const fetcher = options.fetch ?? globalThis.fetch;
  const createSession = options.createSession ?? createDkgLocalLlmRuntimeSession;
  const probeTimeoutMs = options.probeTimeoutMs ?? 2_000;
  const env = options.env ?? process.env;
  const programPath = trimmed(env.DKG_LLM_PROGRAM_EXECUTOR);
  const programOwner = trimmed(env.DKG_LLM_PROGRAM_AGENT)?.toLowerCase();
  const capability: LocalLlmProgramCapability | undefined = programOwner && settings.defaultProjectId
    ? { toolIri: LOCAL_LLM_PROGRAM_TOOL, contextGraphId: settings.defaultProjectId,
      ownerAgentAddress: programOwner, configurationSha256: localLlmConfigurationSha256(settings, programOwner) }
    : undefined;
  let programExecutor: Promise<LocalLlmProgramExecutor> | undefined;
  let closed = false;
  let activeOperation: {
    settlement: Promise<void>;
    controller: AbortController;
  } | undefined;
  let closePromise: Promise<void> | undefined;
  const verifyConfiguration = () => {
    const current = resolveDaemonLocalLlmSettings(options.dkgHome, env);
    if (current.probeConfigurationError || trimmed(env.DKG_LLM_PROGRAM_AGENT)?.toLowerCase() !== programOwner
      || localLlmConfigurationSha256(current, programOwner!) !== capability?.configurationSha256) {
      throw new Error('LOCAL_LLM_PROGRAM_CONFIGURATION_CHANGED_BEFORE_DISPATCH');
    }
    return localLlmAdapterHashes(current.adapterPaths);
  };
  const owner = createLocalLlmSessionOwner({
    dkgHome: options.dkgHome, createSession, settings,
    strictProjectTools: DKG_LOCAL_LLM_STRICT_PROJECT_TOOLS,
    ...(capability ? { verifyConfiguration } : {}), cwd: options.cwd, stderr: options.stderr,
  });
  const provider: LocalLlmProgramProvider | undefined = capability ? {
    capability,
    isEnabled() {
      if (closed || owner.state().closed) return false;
      try { verifyConfiguration(); return true; } catch { return false; }
    },
    run: prompt => owner.run(prompt, capability.contextGraphId, undefined, true),
  } : undefined;

  const probe = (): Promise<LocalModelEndpointAvailability> => {
    if (settings.probeConfigurationError) {
      return Promise.resolve(Object.freeze({
        status: 'offline',
        reachable: false,
        error: `Local LLM endpoint configuration is invalid: ${settings.probeConfigurationError}`,
      }));
    }
    return probeLocalModelEndpoint({
      chatCompletionsUrl: settings.llamaUrl,
      model: settings.model,
      strategy: options.probeStrategy ?? settings.probeStrategy,
      fetch: fetcher,
      timeoutMs: probeTimeoutMs,
    });
  };

  const unavailableError = (
    availability: Exclude<LocalModelEndpointAvailability, { status: 'ready' }>,
  ): DaemonLocalLlmError => new DaemonLocalLlmError(
    availability.status === 'not-ready' ? 'LOCAL_LLM_NOT_READY' : 'LOCAL_LLM_OFFLINE',
    503,
    availability.error,
  );

  const getProgramExecutor = () => (programExecutor ??= (async () => {
    if (!capability || !programPath || !path.isAbsolute(programPath)) throw new Error('LOCAL_LLM_PROGRAM_NOT_CONFIGURED');
    if (options.createProgramExecutor) return options.createProgramExecutor({ dkgHome: options.dkgHome, capability });
    const info = lstatSync(programPath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022)) throw new Error('LOCAL_LLM_PROGRAM_MODULE_UNSAFE');
    const module = await import(pathToFileURL(programPath).href);
    return module.createProgramChatExecutor({ dkgHome: options.dkgHome, capability });
  })());

  return {
    programProvider: provider,
    async health() {
      const availability = await probe();
      const reachable = availability.status !== 'offline';
      let programError: string | undefined;
      if (programPath) {
        try { await getProgramExecutor(); } catch (error) { programError = errorMessage(error); }
      }
      const { initFailure, initialized, hasProjectLock, lockedProjectId, traceFile, busy } = owner.state();
      if (capability && !closed && !provider!.isEnabled()) programError ??= 'LOCAL_LLM_PROGRAM_CONFIGURATION_CHANGED_BEFORE_DISPATCH';
      const ready = availability.status === 'ready' && !initFailure && !programError && !closed;
      return {
        ok: ready,
        configured: settings.configured,
        ready,
        reachable,
        offline: !reachable,
        busy: Boolean(activeOperation) || busy,
        executionMode: programPath ? 'program' : 'direct',
        ...(capability ? { programCapability: capability } : {}),
        initialized,
        readOnly: true,
        sessionId: DKG_LOCAL_LLM_UI_SESSION_ID,
        ...(hasProjectLock && lockedProjectId ? { contextGraphId: lockedProjectId } : {}),
        ...(traceFile ? { traceFile } : {}),
        ...(availability.status !== 'ready' || initFailure || programError
          ? { error: availability.status === 'ready' ? initFailure ?? programError : availability.error }
          : {}),
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
      if (activeOperation || owner.state().busy) {
        throw new DaemonLocalLlmError(
          'LOCAL_LLM_BUSY',
          409,
          'The local LLM session already has a turn in progress.',
        );
      }

      const requestedProjectId = trimmed(input.contextGraphId) ?? settings.defaultProjectId;
      owner.assertProject(requestedProjectId);

      const turnController = new AbortController();
      const signal = input.signal
        ? AbortSignal.any([input.signal, turnController.signal])
        : turnController.signal;
      let settleTurn!: () => void;
      const turnSettlement = new Promise<void>((resolve) => { settleTurn = resolve; });
      const operation = {
        settlement: turnSettlement,
        controller: turnController,
      };
      activeOperation = operation;
      const abortModel = () => owner.abortTurn(signal.reason);
      signal.addEventListener('abort', abortModel, { once: true });
      try {
        const availability = await probe();
        signal.throwIfAborted();
        if (availability.status !== 'ready') throw unavailableError(availability);

        try {
          if (programPath) {
            const result = await (await getProgramExecutor()).chat({ message, contextGraphId: requestedProjectId, signal });
            signal.throwIfAborted();
            owner.lockProject(requestedProjectId);
            return { ...result, sessionId: DKG_LOCAL_LLM_UI_SESSION_ID, readOnly: true };
          }
          const result = await owner.run(message, requestedProjectId, signal);
          signal.throwIfAborted();
          return {
            text: result.answer,
            sessionId: DKG_LOCAL_LLM_UI_SESSION_ID,
            ...(requestedProjectId ? { contextGraphId: requestedProjectId } : {}),
            profile: result.profile,
            toolCalls: result.toolCalls,
            traceFile: result.traceFile ?? owner.state().traceFile,
            readOnly: true,
          };
        } catch (error) {
          if (error instanceof DaemonLocalLlmError) throw error;
          if (signal.aborted) signal.throwIfAborted();
          const availabilityAfterFailure = await probe();
          if (availabilityAfterFailure.status !== 'ready') {
            throw unavailableError(availabilityAfterFailure);
          }
          throw new DaemonLocalLlmError(
            'LOCAL_LLM_RUNTIME_ERROR',
            502,
            errorMessage(error),
          );
        }
      } finally {
        signal.removeEventListener('abort', abortModel);
        if (signal.aborted) { owner.abortTurn(signal.reason); await owner.drain(); }
        settleTurn();
        if (activeOperation === operation) activeOperation = undefined;
      }
    },

    async clear() {
      if (closed) {
        throw new DaemonLocalLlmError(
          'LOCAL_LLM_RUNTIME_ERROR',
          503,
          'The local LLM service is shutting down.',
        );
      }
      if (activeOperation || owner.state().busy) {
        throw new DaemonLocalLlmError(
          'LOCAL_LLM_BUSY',
          409,
          'Wait for the active local LLM turn before clearing the session.',
        );
      }
      await owner.clear();
      return { ok: true, sessionId: DKG_LOCAL_LLM_UI_SESSION_ID, readOnly: true };
    },

    async close() {
      if (!closePromise) {
        closed = true;
        const pendingOperation = activeOperation;
        pendingOperation?.controller?.abort(new Error('The local LLM service is shutting down.'));
        const closingModel = owner.close();
        closePromise = (async () => {
          await pendingOperation?.settlement;
          await closingModel;
        })();
      }
      await closePromise;
    },
  };
}
