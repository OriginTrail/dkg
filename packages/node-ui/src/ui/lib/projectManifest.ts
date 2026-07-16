/**
 * Browser-side wrappers for the three Phase 8 manifest endpoints
 * exposed by the daemon. The endpoints live at
 * `/api/context-graph/{id}/manifest/{publish|plan-install|install}`
 * and are documented inline in `packages/cli/src/daemon.ts`.
 *
 * The actual publish + plan + install logic lives in
 * `@origintrail-official/dkg-mcp/manifest/*` and is reused by the
 * dkg-mcp CLI. The daemon constructs a self-pointing DkgClient and
 * calls those helpers; this module just gives the React components
 * a typed surface to call.
 */
import { authHeaders } from '../api.js';

async function postJson<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  }
  if (!res.ok) {
    const detail = (parsed as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return parsed as T;
}

// ── Publish (curator side, called from CreateProjectModal) ─────────

export interface PublishManifestRequest {
  /** Override the network label resolved from the daemon's loaded network config. */
  networkLabel?: 'testnet' | 'mainnet' | 'devnet';
  /** Tools the manifest declares support for. Defaults to ['cursor', 'claude-code']. */
  supportedTools?: ('cursor' | 'claude-code')[];
  /** Override the agent URI used for prov:wasAttributedTo. Defaults to urn:dkg:agent:<address>. */
  publisherAgentUri?: string;
  /** SemVer range for compatible mcp-dkg installations. Defaults to >=0.1.0. */
  requiresMcpDkgVersion?: string;
  /** Override the ontology URI link. Defaults to urn:dkg:project:<cgId>:ontology. */
  ontologyUri?: string;
}

export interface PublishManifestResult {
  ok: true;
  manifestUri: string;
  templateUris: Record<string, string>;
  tripleCount: number;
  network: 'testnet' | 'mainnet' | 'devnet';
}

export function publishProjectManifest(
  contextGraphId: string,
  req: PublishManifestRequest = {},
): Promise<PublishManifestResult> {
  return postJson<PublishManifestResult>(
    `/api/context-graph/${encodeURIComponent(contextGraphId)}/manifest/publish`,
    req,
  );
}

// ── Plan-install (joiner side, called from WireWorkspacePanel preview) ──

export interface InstallContextRequest {
  /** Absolute path to the operator's workspace directory. */
  workspaceRoot: string;
  /**
   * Free-form human label for this agent, e.g. "Alice on laptop 1".
   * Lands as rdfs:label / schema:name on the agent entity. The cryptographic
   * agent URI is derived server-side from the daemon's wallet address.
   */
  agentNickname: string;
  /**
   * Subset of supportedTools to actually wire on this machine.
   * Defaults to ['cursor']. `claude-code` requires explicit opt-in to avoid
   * touching ~/.claude/settings.json. `codex` is recognised but no-op today.
   */
  tools?: ('cursor' | 'claude-code' | 'codex')[];
  /** Override the daemon-token file path used in the templated config.yaml. */
  daemonTokenFile?: string;
  /** @deprecated — pass nickname via agentNickname; kept for back-compat with old callers. */
  agentSlug?: string;
  /** @deprecated — set tools=['cursor'] to get the old skipClaude=true behaviour. */
  skipClaude?: boolean;
}

export interface PlannedFileSummary {
  field: string;
  absPath: string;
  exists: boolean;
  merges: boolean;
  bytes: number;
  encodingFormat: string;
}

export interface PlanInstallResult {
  ok: true;
  manifest: {
    uri: string;
    contextGraphId: string;
    network: string;
    publishedBy?: string;
    publishedAt?: string;
    supportedTools: string[];
    ontologyUri?: string;
  };
  plan: {
    files: PlannedFileSummary[];
    warnings: string[];
    substitutionValues: Record<string, string>;
  };
  markdown: string;
}

export function planProjectManifestInstall(
  contextGraphId: string,
  req: InstallContextRequest,
): Promise<PlanInstallResult> {
  return postJson<PlanInstallResult>(
    `/api/context-graph/${encodeURIComponent(contextGraphId)}/manifest/plan-install`,
    req,
  );
}

// ── Install (joiner side, called from WireWorkspacePanel commit) ───

export interface InstalledFileSummary {
  field: string;
  absPath: string;
  bytesWritten: number;
  action: 'created' | 'overwrote' | 'merged';
}

export interface InstallResult {
  ok: true;
  written: InstalledFileSummary[];
  warnings: string[];
  skipped: string[];
}

export function installProjectManifest(
  contextGraphId: string,
  req: InstallContextRequest,
): Promise<InstallResult> {
  return postJson<InstallResult>(
    `/api/context-graph/${encodeURIComponent(contextGraphId)}/manifest/install`,
    req,
  );
}
