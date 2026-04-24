/**
 * Shared helpers for scripts that talk to the local DKG daemon.
 *
 * Every importer (code, github, decisions, tasks, profile, book stub, seed
 * orchestrator) funnels its daemon calls through here so bearer-token
 * resolution, URI unwrapping, sub-graph handling, and error shapes stay
 * consistent.
 *
 * Wallet-scoped context-graph ids (task 4hrm):
 * ---------------------------------------------
 * The node-ui creates user-owned context graphs under the canonical id
 * `<wallet>/<slug>` (e.g. `0xd46E.../dkg-code-project`). When these scripts
 * used to pass a bare slug to `/api/paranet/create`, the daemon happily
 * created a *second*, wallet-less "phantom" CG with the same name but a
 * different graph URI — so any triples written by the importers landed in
 * the phantom while the UI/MCP kept reading from the canonical one.
 *
 * `ensureProject` now handles this itself:
 *   1. Look up the caller's wallet address via `/api/agent/identity`.
 *   2. Compute the canonical id `<wallet>/<slug>` (or pass through if
 *      already wallet-scoped / already a DID URI).
 *   3. Check `/api/context-graph/list` for the canonical id. If present,
 *      adopt it. If only the orphaned flat-slug CG exists, warn loudly so
 *      the operator knows to clean it up.
 *   4. Return `{ cgId, … }` and also stash it on `client.cgId` so callers
 *      can use it for every subsequent write/promote/query without having
 *      to re-resolve.
 *
 * Callers MUST use the returned `cgId` (or `client.cgId`) as the
 * `contextGraphId` argument to `writeAssertion`, `promote`, and `query` —
 * passing the bare slug re-introduces the phantom-CG bug.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The canonical single-node daemon listens on 9200; the older multi-node
// devnet scaffolding used 9201. Callers can still override via
// `DEVNET_API` or by passing `apiBase` explicitly.
const DEFAULT_API = 'http://localhost:9200';

export function parseArgs(argv = process.argv.slice(2)) {
  return Object.fromEntries(
    argv.map(a => {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/);
      return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    }),
  );
}

/**
 * Resolve a bearer token in this precedence:
 *   1. DEVNET_TOKEN / DKG_AUTH environment variables
 *   2. `~/.dkg/auth.token` (standalone `dkg start` daemon — default setup)
 *   3. `<repoRoot>/.devnet/node<N>/auth.token` (devnet scaffolding)
 *
 * The standalone daemon is what most contributors run day-to-day, and
 * stale tokens left behind by old `.devnet` folders otherwise silently
 * shadow the live one. Explicit env vars still win over both.
 */
export function resolveToken(repoRoot, { nodeId = 1 } = {}) {
  if (process.env.DEVNET_TOKEN) return process.env.DEVNET_TOKEN.trim();
  if (process.env.DKG_AUTH) return process.env.DKG_AUTH.trim();

  const candidates = [
    path.join(os.homedir(), '.dkg/auth.token'),
    path.resolve(repoRoot, `.devnet/node${nodeId}/auth.token`),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const line = raw.split('\n').find(l => l.trim() && !l.startsWith('#'));
    if (line) return line.trim();
  }
  throw new Error(
    `No auth token: set DEVNET_TOKEN or populate one of: ${candidates.join(', ')}. ` +
    `If your devnet lives elsewhere, export DEVNET_TOKEN with the node's bearer token.`,
  );
}

/** Strip angle brackets from a bracketed IRI. The daemon's formatTerm expects
 *  bare IRIs for subject/predicate in quad payloads. Literals are left alone. */
export function unwrap(iri) {
  return iri.startsWith('<') && iri.endsWith('>') ? iri.slice(1, -1) : iri;
}

/** True if `id` is already a fully-qualified CG id we should pass through as-is. */
function looksCanonical(id) {
  // `<wallet>/<slug>` form — any id that already contains a wallet
  // prefix (EVM address, peerId, or did:dkg:… prefix) stays untouched.
  if (id.includes('/')) return true;
  if (id.startsWith('did:')) return true;
  return false;
}

export class DkgClient {
  constructor({ apiBase, token, logger = console } = {}) {
    this.apiBase = (apiBase ?? process.env.DEVNET_API ?? DEFAULT_API).replace(/\/$/, '');
    this.token = token;
    this.logger = logger;
    // Filled in by `ensureProject`; callers should read this before
    // composing writes so every assertion targets the canonical CG.
    this.cgId = null;
    this.agentAddress = null;
  }

  async request(method, route, body) {
    const res = await fetch(`${this.apiBase}${route}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`${method} ${route} -> ${res.status}: ${JSON.stringify(parsed)}`);
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }

  /** Resolve the wallet address bound to this token (cached on the client). */
  async resolveAgentIdentity() {
    if (this.agentAddress) return this.agentAddress;
    const info = await this.request('GET', '/api/agent/identity');
    if (!info?.agentAddress) {
      throw new Error(
        `Daemon did not return an agentAddress for this token (got ${JSON.stringify(info)}). ` +
        `Make sure the token is valid and the daemon is running.`,
      );
    }
    this.agentAddress = info.agentAddress;
    return this.agentAddress;
  }

  /** Compute `<wallet>/<slug>` for a bare slug, or return as-is if already canonical. */
  async toCanonicalCgId(slug) {
    if (looksCanonical(slug)) return slug;
    const wallet = await this.resolveAgentIdentity();
    return `${wallet}/${slug}`;
  }

  async listContextGraphs() {
    const body = await this.request('GET', '/api/context-graph/list');
    return body?.contextGraphs ?? body?.paranets ?? [];
  }

  /**
   * Ensure a project (context graph) exists under the caller's canonical
   * wallet-scoped id. Handles three cases:
   *
   *   - `<wallet>/<slug>` already exists → adopt it.
   *   - `<wallet>/<slug>` does NOT exist but the orphaned flat-slug CG
   *     does → warn loudly, still create the canonical one.
   *   - Neither exists → create the canonical one.
   *
   * Returns `{ cgId, created, phantomDetected }`. Also assigns `client.cgId`
   * so downstream calls don't have to pass it around.
   */
  async ensureProject({ id, name, description }) {
    const cgId = await this.toCanonicalCgId(id);
    const bareSlug = looksCanonical(id) ? null : id;

    let existing = [];
    try {
      existing = await this.listContextGraphs();
    } catch (err) {
      // Older daemons without the list endpoint — fall through to the
      // POST-and-handle-"already exists" path on the canonical id.
      this.logger.warn(
        `[dkg] context-graph list failed (${err.message}); creating '${cgId}' blind.`,
      );
    }

    const hasCanonical = existing.some(cg => cg.id === cgId);
    const hasPhantom = !!bareSlug && existing.some(cg => cg.id === bareSlug);

    if (hasPhantom && !hasCanonical) {
      this.logger.warn(
        `[dkg] WARNING: a wallet-less context graph '${bareSlug}' exists on this node. ` +
        `This script will create/use the canonical '${cgId}' instead. ` +
        `Any triples previously written to the flat-slug CG are orphaned — ` +
        `inspect it with:\n` +
        `  curl -s -H "Authorization: Bearer $TOKEN" ${this.apiBase}/api/context-graph/list | jq '.contextGraphs[] | select(.id==\"${bareSlug}\")'\n` +
        `and drop it via the UI or \`dkg paranet delete\` once confirmed safe.`,
      );
    } else if (hasPhantom && hasCanonical) {
      this.logger.warn(
        `[dkg] NOTE: both '${cgId}' and the phantom '${bareSlug}' exist on this node. ` +
        `Using '${cgId}' — the flat-slug CG is orphaned and safe to delete.`,
      );
    }

    this.cgId = cgId;

    if (hasCanonical) {
      // Keep the name in sync with what the caller declared, same as the
      // old already-exists branch. The rename endpoint is idempotent.
      try {
        await this.request('POST', '/api/context-graph/rename', { id: cgId, name });
        this.logger.log(`[dkg] Project '${cgId}' already exists — name synced to '${name}'.`);
      } catch {
        this.logger.log(`[dkg] Project '${cgId}' already exists — reusing.`);
      }
      return { cgId, created: false, phantomDetected: hasPhantom };
    }

    try {
      await this.request('POST', '/api/paranet/create', { id: cgId, name, description });
      this.logger.log(`[dkg] Created project '${cgId}' (${name}).`);
      return { cgId, created: true, phantomDetected: hasPhantom };
    } catch (err) {
      // Race: another process won the create. Treat as success.
      if (String(err.message).includes('already exists')) {
        try {
          await this.request('POST', '/api/context-graph/rename', { id: cgId, name });
          this.logger.log(`[dkg] Project '${cgId}' already exists — name synced to '${name}'.`);
        } catch {
          this.logger.log(`[dkg] Project '${cgId}' already exists — reusing.`);
        }
        return { cgId, created: false, phantomDetected: hasPhantom };
      }
      throw err;
    }
  }

  async renameProject(id, name) {
    const cgId = await this.toCanonicalCgId(id);
    await this.request('POST', '/api/context-graph/rename', { id: cgId, name });
    return { renamed: cgId, name };
  }

  async ensureSubGraph(contextGraphId, subGraphName) {
    try {
      await this.request('POST', '/api/sub-graph/create', { contextGraphId, subGraphName });
      this.logger.log(`[dkg]   + sub-graph '${subGraphName}'`);
      return { created: true };
    } catch (err) {
      if (String(err.message).includes('already exists')) {
        this.logger.log(`[dkg]   · sub-graph '${subGraphName}' already exists`);
        return { created: false };
      }
      throw err;
    }
  }

  /** Write triples into an assertion on a given sub-graph. Batches internally. */
  async writeAssertion(
    { contextGraphId, assertionName, subGraphName, triples },
    { batchSize = 500, label } = {},
  ) {
    const tag = label ?? assertionName;
    let written = 0;
    for (let i = 0; i < triples.length; i += batchSize) {
      const batch = triples.slice(i, i + batchSize).map(t => ({
        subject: unwrap(t.subject),
        predicate: unwrap(t.predicate),
        object: t.object,
      }));
      await this.request(
        'POST',
        `/api/assertion/${encodeURIComponent(assertionName)}/write`,
        {
          contextGraphId,
          quads: batch,
          ...(subGraphName ? { subGraphName } : {}),
        },
      );
      written += batch.length;
      process.stdout.write(`\r[dkg] ${tag}: wrote ${written}/${triples.length} triples`);
    }
    if (triples.length) process.stdout.write('\n');
    return written;
  }

  async promote({ contextGraphId, assertionName, entities = 'all', subGraphName }) {
    return this.request(
      'POST',
      `/api/assertion/${encodeURIComponent(assertionName)}/promote`,
      { contextGraphId, entities, ...(subGraphName ? { subGraphName } : {}) },
    );
  }

  async query({ sparql, contextGraphId, subGraphName, assertionName }) {
    return this.request('POST', '/api/query', {
      sparql,
      contextGraphId,
      ...(subGraphName ? { subGraphName } : {}),
      ...(assertionName ? { assertionName } : {}),
    });
  }
}

export function makeClient({ apiBase, token, logger } = {}) {
  return new DkgClient({ apiBase, token, logger });
}
