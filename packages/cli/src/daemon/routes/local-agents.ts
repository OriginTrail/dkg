// daemon/routes/local-agents.ts
//
// Route handlers for local-agent-integrations list / connect / update / reverse / refresh.
//
// Extracted verbatim from the legacy monolithic `handleRequest` —
// every block is a contiguous slice of the original source with zero
// edits to route bodies. Dispatch is driven by the surviving
// `handle-request.ts` shell, which awaits each group handler in
// sequence and uses `res.writableEnded` to short-circuit once a
// route claims the request.
//
// See `packages/cli/scripts/split-handle-request.mjs` for the
// extraction driver.

import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

// Namespace import: our Phase-8 install-context builder (~line 290) calls
// `osModule.homedir()`, and the later agent-identity probe (~line 6851)
// uses `osModule.hostname()` + `osModule.userInfo()`. v10-rc's new
// OpenClaw config helper (~line 2535) uses a bare `homedir()` — aliased
// below so both sites coexist without a duplicate-module import.
import * as osModule from 'node:os';
const { homedir } = osModule;

import { createRequire } from 'node:module';

// Lazy resolver used by the manifest-install flow: find the
// @origintrail-official/dkg-mcp package via Node's own resolution
// algorithm, so the daemon can write workspace-level configs that
// point at a valid MCP server install regardless of whether it's
// running from a monorepo checkout, an npm-global `dkg`, or a
// `pnpm dlx` tarball.
const daemonRequire = createRequire(import.meta.url);

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

import { saveConfig } from '../../config.js';

// Phase 8 — project-manifest publish + install (UI-driven onboarding flow).
// Daemon constructs a self-pointing DkgClient (localhost:listenPort) and
// reuses the same publish/fetch/plan/write helpers the CLI uses, so wire
// format stays identical between curator/joiner/CLI paths.

// Daemon sub-module imports — every public symbol from sibling
// modules is pulled in here because the legacy monolithic file used
// them all without explicit imports. Unused ones are tolerated by
// the project's tsconfig (`noUnusedLocals` is off).

import { _autoUpdateIo } from '../manifest.js';
import { jsonResponse, SMALL_BODY_BYTES, readBody } from '../http-utils.js';

import { cancelPendingLocalAgentAttachJob } from '../openclaw.js';
import { LOCAL_AGENT_INTEGRATION_DEFINITIONS, isPlainRecord, normalizeIntegrationId, normalizeExplicitLocalAgentDisconnectBody, listLocalAgentIntegrations, getLocalAgentIntegration, connectLocalAgentIntegration, updateLocalAgentIntegration, connectLocalAgentIntegrationFromUi, reverseHermesSetupForUi, reverseLocalAgentSetupForUi, refreshLocalAgentIntegrationFromUi } from '../local-agents.js';
import {
  primeAgentDkgSessionId,
  readPrimeAgentSessions,
} from '../prime-agent.js';

import type { RequestContext } from './context.js';

/**
 * Prime Agent is the one integration whose "is it there" answer is not derivable
 * from config: a bridge exists per live session, so the count changes without
 * anything in the node changing. The listing therefore reads the discovery
 * directory (a sync readdir over a handful of small files, already the hot path
 * for the chat routes) so the UI can distinguish "installed but idle" from
 * "not installed" without a second round trip.
 */
function withPrimeAgentSessionCounts<T extends { id: string; metadata?: Record<string, unknown> }>(
  integrations: T[],
): T[] {
  return integrations.map((integration) => {
    if (integration.id !== 'prime-agent') return integration;
    let sessions: ReturnType<typeof readPrimeAgentSessions>;
    try {
      sessions = readPrimeAgentSessions();
    } catch {
      // Discovery is best-effort: an unreadable directory must not take down
      // the whole integrations listing.
      return integration;
    }
    const metadata: Record<string, unknown> = {
      ...(integration.metadata ?? {}),
      sessionCount: sessions.length,
    };
    if (sessions[0]) {
      metadata.activeSessionId = sessions[0].sessionId;
      metadata.activeMemorySessionId = primeAgentDkgSessionId(sessions[0].sessionId);
    } else {
      // A zero-session listing must not keep advertising the connect-time
      // session ids: node-ui pins history to activeMemorySessionId, and stale
      // raw/memory ids would route every send into a guaranteed 409.
      delete metadata.activeSessionId;
      delete metadata.activeMemorySessionId;
    }
    return { ...integration, metadata };
  });
}

/**
 * Single-integration responses (get / connect / refresh) need the same overlay
 * as the listing: node-ui upserts each of them into its integrations state, so
 * any un-overlaid response would regress the pinned session to the persisted
 * connect-time id until the next listing poll.
 */
function withPrimeAgentSessionCount<T extends { id: string; metadata?: Record<string, unknown> }>(
  integration: T,
): T {
  return withPrimeAgentSessionCounts([integration])[0];
}

export async function handleLocalAgentsRoutes(ctx: RequestContext): Promise<void> {
  const {
    req,
    res,
    agent,
    publisherControl,
    config,
    startedAt,
    dashDb,
    opWallets,
    network,
    tracker,
    memoryManager,
    bridgeAuthToken,
    nodeVersion,
    nodeCommit,
    catchupTracker,
    extractionRegistry,
    fileStore,
    extractionStatus,
    assertionImportLocks,
    vectorStore,
    embeddingProvider,
    validTokens,
    apiHost,
    apiPortRef,
    url,
    path,
    requestAgentAddress,
  } = ctx;

  // GET /api/local-agent-integrations — generic local agent registry/status surface
  if (req.method === 'GET' && path === '/api/local-agent-integrations') {
    return jsonResponse(res, 200, {
      integrations: withPrimeAgentSessionCounts(listLocalAgentIntegrations(config)),
    });
  }

  // GET /api/local-agent-integrations/:id — single local agent integration status
  if (req.method === 'GET' && path.startsWith('/api/local-agent-integrations/')) {
    const id = path.slice('/api/local-agent-integrations/'.length);
    if (!id) return jsonResponse(res, 404, { error: 'Integration not found' });
    const integration = getLocalAgentIntegration(config, id);
    if (!integration) return jsonResponse(res, 404, { error: `Unknown integration: ${id}` });
    return jsonResponse(res, 200, { integration: withPrimeAgentSessionCount(integration) });
  }

  // POST /api/local-agent-integrations/connect — upsert/connect an integration
  if (req.method === 'POST' && path === '/api/local-agent-integrations/connect') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: 'Invalid JSON body' }); }
    if (normalizeIntegrationId(typeof parsed.id === 'string' ? parsed.id : '') === 'local-llm') {
      return jsonResponse(res, 409, {
        error: 'DKG Local LLM is daemon-managed and does not require a connect or install step.',
        code: 'DAEMON_MANAGED_INTEGRATION',
      });
    }
    try {
      const source = isPlainRecord(parsed.metadata) && typeof parsed.metadata.source === 'string'
        ? parsed.metadata.source
        : undefined;
      const result = source === 'node-ui'
        ? await connectLocalAgentIntegrationFromUi(config, parsed, bridgeAuthToken, { saveConfig })
        : { integration: connectLocalAgentIntegration(config, parsed) };
      await saveConfig(config);
      return jsonResponse(res, 200, {
        ok: true,
        integration: withPrimeAgentSessionCount(result.integration),
        notice: result.notice,
      });
    } catch (err: any) {
      try { await saveConfig(config); } catch { /* best effort: preserve failed attach state when available */ }
      return jsonResponse(res, 400, { error: err?.message ?? 'Invalid local agent integration payload' });
    }
  }

  // POST /api/local-agent-integrations/:id/refresh — re-probe bridge health (OpenClaw) or
  // return the current record (other integrations that don't yet have a bridge).
  if (
    req.method === 'POST'
    && path.startsWith('/api/local-agent-integrations/')
    && path.endsWith('/refresh')
  ) {
    const segments = path.slice('/api/local-agent-integrations/'.length, -'/refresh'.length);
    if (!segments || segments.includes('/')) {
      return jsonResponse(res, 404, { error: 'Unknown integration' });
    }
    const rawId = decodeURIComponent(segments);
    const normalizedId = normalizeIntegrationId(rawId);
    if (!LOCAL_AGENT_INTEGRATION_DEFINITIONS[normalizedId]) {
      return jsonResponse(res, 404, { error: 'Unknown integration' });
    }
    try {
      const integration = await refreshLocalAgentIntegrationFromUi(config, normalizedId, bridgeAuthToken);
      await saveConfig(config);
      return jsonResponse(res, 200, { ok: true, integration: withPrimeAgentSessionCount(integration) });
    } catch (err: any) {
      return jsonResponse(res, 400, { error: err?.message ?? 'Integration refresh failed' });
    }
  }

  // PUT /api/local-agent-integrations/:id — partial update for stored integration state
  if (req.method === 'PUT' && path.startsWith('/api/local-agent-integrations/')) {
    const id = path.slice('/api/local-agent-integrations/'.length);
    if (!id) return jsonResponse(res, 404, { error: 'Integration not found' });
    if (normalizeIntegrationId(id) === 'local-llm') {
      return jsonResponse(res, 409, {
        error: 'DKG Local LLM is daemon-managed and cannot be connected or disconnected.',
        code: 'DAEMON_MANAGED_INTEGRATION',
      });
    }
    const body = await readBody(req, SMALL_BODY_BYTES);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: 'Invalid JSON body' }); }
    try {
      const normalizedId = normalizeIntegrationId(id);
      const normalizedPatch = normalizeExplicitLocalAgentDisconnectBody(parsed);
      const explicitDisconnect = normalizedPatch.enabled === false
        && isPlainRecord(normalizedPatch.runtime)
        && normalizedPatch.runtime.status === 'disconnected';
      if (explicitDisconnect && normalizedId) {
        cancelPendingLocalAgentAttachJob(normalizedId);
      }

      if (explicitDisconnect && normalizedId === 'openclaw') {
        try {
          await reverseLocalAgentSetupForUi(config);
        } catch (err: any) {
          const integration = updateLocalAgentIntegration(config, id, {
            runtime: {
              status: 'error',
              ready: false,
              lastError: `OpenClaw disconnect failed: ${err?.message ?? 'unknown error'}`,
            },
          });
          await saveConfig(config);
          return jsonResponse(res, 200, { ok: true, integration });
        }
      }

      if (explicitDisconnect && normalizedId === 'prime-agent') {
        // Reverse setup removes our entry from settings.json.extensions. A
        // restore failure must NOT be reported as a failed disconnect: the
        // integration really is disconnected either way, and surfacing it as
        // `error` would leave the operator unable to clear the state. Same
        // posture as the Hermes branch below — warn, do not fail.
        let restoreError: string | undefined;
        try {
          const { restorePrimeAgentProfile } = await import('@origintrail-official/dkg-adapter-prime-agent');
          const result = await restorePrimeAgentProfile({});
          if (!result?.ok) restoreError = result?.restoreError ?? 'restore reported failure';
        } catch (err: any) {
          restoreError = `Prime Agent restore failed: ${err?.message ?? 'unknown error'}`;
        }
        const integration = updateLocalAgentIntegration(config, id, {
          runtime: {
            status: 'disconnected',
            ready: false,
            lastError: restoreError ?? null,
          },
        });
        await saveConfig(config);
        return jsonResponse(res, 200, { ok: true, integration });
      }

      if (explicitDisconnect && normalizedId === 'hermes') {
        let hermesRestoreError: string | undefined;
        try {
          const result = await reverseHermesSetupForUi(config);
          hermesRestoreError = result.restoreError;
        } catch (err: any) {
          // Disconnect proper failed (not restore) — surface as error,
          // matching today's behavior. Restore-only failures fall through
          // to the disconnected-with-warning patch below.
          const integration = updateLocalAgentIntegration(config, id, {
            runtime: {
              status: 'error',
              ready: false,
              lastError: `Hermes disconnect failed: ${err?.message ?? 'unknown error'}`,
            },
          });
          await saveConfig(config);
          return jsonResponse(res, 200, { ok: true, integration });
        }

        // Per setup-entrypoint-contract.md §6: restore failure does NOT roll
        // back the disconnect. Integration stays `disconnected`; the failure
        // surfaces as a warning via `runtime.lastError` while the rest of the
        // patch (enabled:false, runtime.status:'disconnected', ready:false)
        // proceeds normally. The UI's disconnected pill + warning chip
        // (PanelRight.tsx, S3 step 5) renders this combination as warning-not-error.
        if (hermesRestoreError) {
          const integration = updateLocalAgentIntegration(config, id, {
            ...normalizedPatch,
            runtime: {
              ...(isPlainRecord(normalizedPatch.runtime) ? normalizedPatch.runtime : {}),
              status: 'disconnected',
              ready: false,
              lastError: hermesRestoreError,
            },
          });
          await saveConfig(config);
          return jsonResponse(res, 200, { ok: true, integration });
        }
      }

      const integration = updateLocalAgentIntegration(config, id, normalizedPatch);
      await saveConfig(config);
      return jsonResponse(res, 200, { ok: true, integration });
    } catch (err: any) {
      return jsonResponse(res, 400, { error: err?.message ?? 'Invalid local agent integration payload' });
    }
  }
}
