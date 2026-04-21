/**
 * Shared helpers for scripts that talk to the local DKG daemon.
 *
 * Every importer (code, github, decisions, tasks, profile, book stub, seed
 * orchestrator) funnels its daemon calls through here so bearer-token
 * resolution, URI unwrapping, sub-graph handling, and error shapes stay
 * consistent.
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_API = 'http://localhost:9201';

export function parseArgs(argv = process.argv.slice(2)) {
  return Object.fromEntries(
    argv.map(a => {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/);
      return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    }),
  );
}

export function resolveToken(repoRoot, { nodeId = 1 } = {}) {
  if (process.env.DEVNET_TOKEN) return process.env.DEVNET_TOKEN.trim();
  if (process.env.DKG_AUTH) return process.env.DKG_AUTH.trim();
  const tokenFile = path.resolve(repoRoot, `.devnet/node${nodeId}/auth.token`);
  if (!fs.existsSync(tokenFile)) {
    throw new Error(
      `No auth token: set DEVNET_TOKEN or provide ${tokenFile}. ` +
      `If your devnet lives elsewhere, export DEVNET_TOKEN with the node's bearer token.`,
    );
  }
  const raw = fs.readFileSync(tokenFile, 'utf8');
  const line = raw.split('\n').find(l => l.trim() && !l.startsWith('#'));
  if (!line) throw new Error(`Auth token file is empty: ${tokenFile}`);
  return line.trim();
}

/** Strip angle brackets from a bracketed IRI. The daemon's formatTerm expects
 *  bare IRIs for subject/predicate in quad payloads. Literals are left alone. */
export function unwrap(iri) {
  return iri.startsWith('<') && iri.endsWith('>') ? iri.slice(1, -1) : iri;
}

export class DkgClient {
  constructor({ apiBase, token, logger = console } = {}) {
    this.apiBase = (apiBase ?? process.env.DEVNET_API ?? DEFAULT_API).replace(/\/$/, '');
    this.token = token;
    this.logger = logger;
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

  async ensureProject({ id, name, description }) {
    try {
      await this.request('POST', '/api/paranet/create', { id, name, description });
      this.logger.log(`[dkg] Created project '${id}' (${name}).`);
      return { created: true };
    } catch (err) {
      if (String(err.message).includes('already exists')) {
        // Re-apply the name in case the caller updated it. The daemon's
        // rename endpoint is idempotent so this is safe on every run.
        try {
          await this.request('POST', '/api/context-graph/rename', { id, name });
          this.logger.log(`[dkg] Project '${id}' already exists — renamed to '${name}'.`);
        } catch (renameErr) {
          // Older daemons don't have /api/context-graph/rename; silently
          // reuse the existing name rather than failing the whole seed.
          this.logger.log(`[dkg] Project '${id}' already exists — reusing.`);
        }
        return { created: false };
      }
      throw err;
    }
  }

  async renameProject(id, name) {
    await this.request('POST', '/api/context-graph/rename', { id, name });
    return { renamed: id, name };
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
