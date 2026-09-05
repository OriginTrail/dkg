// daemon/handle-request.ts
//
// The `handleRequest` HTTP router (~5,160 lines) extracted verbatim
// from the legacy monolithic `daemon.ts`. Single switch over URL
// pathnames; called per-request by the http server set up in
// `./lifecycle.ts`.
//
// Splitting this internally by route group is the next AI-DX win
// and is queued as a follow-up PR.

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

// Phase 8 — project-manifest publish + install (UI-driven onboarding flow).
// Daemon constructs a self-pointing DkgClient (localhost:listenPort) and
// reuses the same publish/fetch/plan/write helpers the CLI uses, so wire
// format stays identical between curator/joiner/CLI paths.

// Daemon sub-module imports — every public symbol from sibling
// modules is pulled in here because the legacy monolithic file used
// them all without explicit imports. Unused ones are tolerated by
// the project's tsconfig (`noUnusedLocals` is off).

import { _autoUpdateIo } from './manifest.js';
import { jsonResponse } from './http-utils.js';

import type { RequestContext, RequestContextInputFields } from './routes/context.js';
import { createRequestActor } from './routes/context.js';
import type { AllowedHttpAuthentication } from '../auth.js';
import { handleStatusRoutes } from './routes/status.js';
import { handleBackpressureRoutes } from './routes/backpressure.js';
import { handleAgentChatRoutes } from './routes/agent-chat.js';
import { handleOpenclawRoutes } from './routes/openclaw.js';
import { handleHermesRoutes } from './routes/hermes.js';
import { handlePrimeAgentRoutes } from './routes/prime-agent.js';
import { handleLocalLlmRoutes } from './routes/local-llm.js';
import { handleMemoryRoutes } from './routes/memory.js';
import { handlePublisherRoutes } from './routes/publisher.js';
import { handleContextGraphRoutes } from './routes/context-graph.js';
import { handleKnowledgeAssetsRoutes } from './routes/knowledge-assets.js';
import { handleKcChainMetadataRoutes } from './routes/kc-chain-metadata.js';
import { handleFileServingRoutes } from './routes/file-serving.js';
import { handleQueryRoutes } from './routes/query.js';
import { handleCclRoutes } from './routes/ccl.js';
import { handleLocalAgentsRoutes } from './routes/local-agents.js';
import { handleEpcisRoutes } from './routes/epcis.js';
import { handlePcaRoutes } from './routes/pca.js';
import { handleOperationalWalletRoutes } from './routes/operational-wallets.js';
import { handleNotificationRoutes } from './routes/notifications.js';
import { handlePluginRoutes } from './routes/plugins.js';

export type HandleRequestInput = Omit<
  RequestContextInputFields,
  | 'url'
  | 'path'
  | 'actor'
  | 'authentication'
  | 'requestAgentAddress'
> & { readonly authentication: AllowedHttpAuthentication };

export async function handleRequest(input: HandleRequestInput): Promise<void> {
  const { req, res, agent, authentication, ...contextInput } = input;
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;

  // Build one actor from the accepted authentication decision. Compatibility properties are
  // read-only getters over this value, never independently stored request state.
  const actor = createRequestActor(
    authentication,
    (acceptedToken) => agent.resolveAgentAddress(acceptedToken),
  );
  const ctxBase = {
    ...contextInput,
    req,
    res,
    agent,
    url,
    path,
    actor,
  };
  const ctx = Object.defineProperties(ctxBase, {
    authentication: {
      enumerable: true,
      get: () => actor.authentication,
    },
    requestAgentAddress: {
      enumerable: true,
      get: () => actor.effectiveAgentAddress,
    },
  }) as RequestContext;

  await handleStatusRoutes(ctx);
  if (res.writableEnded) return;

  await handleBackpressureRoutes(ctx);
  if (res.writableEnded) return;

  await handleAgentChatRoutes(ctx);
  if (res.writableEnded) return;

  await handleOpenclawRoutes(ctx);
  if (res.writableEnded) return;

  await handleHermesRoutes(ctx);
  if (res.writableEnded) return;

  await handlePrimeAgentRoutes(ctx);
  if (res.writableEnded) return;

  await handleLocalLlmRoutes(ctx);
  if (res.writableEnded) return;

  await handleMemoryRoutes(ctx);
  if (res.writableEnded) return;

  await handlePublisherRoutes(ctx);
  if (res.writableEnded) return;

  await handleContextGraphRoutes(ctx);
  if (res.writableEnded) return;

  await handleKnowledgeAssetsRoutes(ctx);
  if (res.writableEnded) return;

  await handleKcChainMetadataRoutes(ctx);
  if (res.writableEnded) return;

  await handleFileServingRoutes(ctx);
  if (res.writableEnded) return;

  await handleQueryRoutes(ctx);
  if (res.writableEnded) return;

  await handleCclRoutes(ctx);
  if (res.writableEnded) return;

  await handleLocalAgentsRoutes(ctx);
  if (res.writableEnded) return;

  await handleEpcisRoutes(ctx);
  if (res.writableEnded) return;

  await handlePcaRoutes(ctx);
  if (res.writableEnded) return;

  await handleOperationalWalletRoutes(ctx);
  if (res.writableEnded) return;

  await handleNotificationRoutes(ctx);
  if (res.writableEnded) return;

  await handlePluginRoutes(ctx);
  // Streaming plugins set `headersSent` without `end()`; treat that as claimed too, else the 404 below crashes ERR_HTTP_HEADERS_SENT.
  if (res.writableEnded || res.headersSent) return;

  jsonResponse(res, 404, { error: 'Not found' });
}
