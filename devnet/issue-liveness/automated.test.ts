/**
 * Multi-node issue-liveness regression suite (live devnet).
 *
 * Reproduces confirmed-live cross-node bugs from the rc.17 QA sweep. Each is a
 * plain failing `it()` repro: it asserts the CORRECT behaviour, so it is RED
 * while the bug is live and turns GREEN when fixed — signalling that the linked
 * GitHub issue can close. Separate CONTROL tests prove the harness preconditions
 * (SWM replicated, import landed) so a repro can't go red for a setup reason
 * without you knowing which.
 *
 *   #705 / #923 — assertion lifecycle metadata (`dkg:state`, the `_meta`
 *                 lifecycle record) is written ONLY on the authoring node and is
 *                 not replicated, so a peer that received the SWM data cannot
 *                 resolve the assertion's lifecycle state / descriptor.
 *                 https://github.com/OriginTrail/dkg/issues/705
 *                 https://github.com/OriginTrail/dkg/issues/923
 *
 *   #872 — imported Markdown SOURCE bytes are not replicated to peers of a
 *          public/open CG; a peer that synced the structural triples cannot
 *          fetch the original document via import-artifact/read-markdown.
 *          https://github.com/OriginTrail/dkg/issues/872
 *
 * Preconditions:
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *   node devnet/_bootstrap/bootstrap.cjs
 *   Run: pnpm test:devnet:issue-liveness
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as http from 'node:http';

const REPO_ROOT = resolve(__dirname, '../..');
const DEVNET_DIR = join(REPO_ROOT, '.devnet');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DevnetNode {
  num: number;
  apiPort: number;
  home: string;
  authToken: string;
}

function readNode(num: number): DevnetNode {
  const home = join(DEVNET_DIR, `node${num}`);
  if (!existsSync(home)) {
    throw new Error(`Devnet node${num} home missing — run ./scripts/devnet.sh start 6 first`);
  }
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  let authToken = '';
  if (existsSync(join(home, 'auth.token'))) {
    authToken =
      readFileSync(join(home, 'auth.token'), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith('#')) ?? '';
  }
  return { num, apiPort: config.apiPort, home, authToken };
}

function request(
  method: 'GET' | 'POST',
  url: string,
  token: string,
  body?: unknown,
  contentType = 'application/json',
): Promise<{ status: number; body: any }> {
  return new Promise((resolveP, rejectP) => {
    const u = new URL(url);
    const data =
      body === undefined ? '' : contentType === 'application/json' ? JSON.stringify(body) : (body as string);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        method,
        path: u.pathname + u.search,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(data ? { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolveP({ status: res.statusCode ?? 0, body: JSON.parse(buf) });
          } catch {
            resolveP({ status: res.statusCode ?? 0, body: buf });
          }
        });
      },
    );
    req.on('error', rejectP);
    if (data) req.write(data);
    req.end();
  });
}

const api = (n: DevnetNode) => `http://127.0.0.1:${n.apiPort}`;
const get = (n: DevnetNode, p: string) => request('GET', api(n) + p, n.authToken);
const post = (n: DevnetNode, p: string, b: unknown) => request('POST', api(n) + p, n.authToken, b);

const STAMP = Date.now();
const CG = `issue-liveness-${STAMP}`;
const KA = `liveness-ka-${STAMP}`;
const ENTITY = `https://example.org/liveness/${STAMP}`;

let node1: DevnetNode;
let node2: DevnetNode;
let assertionUri = '';
let importFileHash = '';
let importAssertionUri = '';

describe('multi-node issue liveness', () => {
  beforeAll(async () => {
    node1 = readNode(1);
    node2 = readNode(2);

    // node1: public CG, registered on-chain.
    await post(node1, '/api/context-graph/create', { id: CG, name: `Liveness ${STAMP}`, accessPolicy: 0 });
    await post(node1, '/api/context-graph/register', { id: CG });

    // node1: create → write → finalize → share a named assertion.
    await post(node1, '/api/knowledge-assets', { contextGraphId: CG, name: KA });
    await post(node1, `/api/knowledge-assets/${KA}/wm/write`, {
      contextGraphId: CG,
      quads: [{ subject: ENTITY, predicate: 'https://schema.org/name', object: '"LivenessEntity"' }],
    });
    await post(node1, `/api/knowledge-assets/${KA}/wm/finalize`, { contextGraphId: CG });
    const share = await post(node1, `/api/knowledge-assets/${KA}/swm/share`, { contextGraphId: CG, entities: 'all' });
    expect(share.status).toBe(200);

    // node1: import a Markdown file + promote (for #872).
    const md = `# Liveness Doc ${STAMP}\n\nSection A — replicated bytes check.\n`;
    const boundary = '----dkgLiveness' + STAMP;
    const multipart =
      `--${boundary}\r\nContent-Disposition: form-data; name="contextGraphId"\r\n\r\n${CG}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="liveness-${STAMP}.md"\r\n` +
      `Content-Type: text/markdown\r\n\r\n${md}\r\n--${boundary}--\r\n`;
    const imp = await request(
      'POST',
      `${api(node1)}/api/knowledge-assets/liveness-import-${STAMP}/wm/import-file`,
      node1.authToken,
      multipart,
      `multipart/form-data; boundary=${boundary}`,
    );
    if (imp.status === 200 && imp.body) {
      importFileHash = imp.body.fileHash ?? '';
      importAssertionUri = imp.body.assertionUri ?? '';
      await post(node1, `/api/knowledge-assets/liveness-import-${STAMP}/swm/share`, {
        contextGraphId: CG,
        entities: 'all',
      });
    }

    assertionUri = `did:dkg:context-graph:${CG}/assertion/`;

    // node2: subscribe + give catch-up time to replicate the SWM data.
    await post(node2, '/api/context-graph/subscribe', { contextGraphId: CG });
    for (let i = 0; i < 24; i++) {
      const r = await post(node2, '/api/query', {
        sparql: `SELECT ?o WHERE { ?s <https://schema.org/name> ?o }`,
        contextGraphId: CG,
        view: 'shared-working-memory',
      });
      const rows = r.body?.result?.bindings?.length ?? 0;
      if (rows > 0) break;
      await sleep(5000);
    }
  }, 240_000);

  it('CONTROL: node2 replicated the SWM data for the peer-authored assertion', async () => {
    const r = await post(node2, '/api/query', {
      sparql: `SELECT ?o WHERE { ?s <https://schema.org/name> ?o }`,
      contextGraphId: CG,
      view: 'shared-working-memory',
    });
    const names = (r.body?.result?.bindings ?? []).map((b: any) => b.o);
    expect(names.some((n: string) => String(n).includes('LivenessEntity'))).toBe(true);
  });

  it('GH #705/#923: node2 can resolve lifecycle state for the peer-authored assertion', async () => {
    // The lifecycle record lives only in node1's non-replicated `_meta`, so
    // node2 sees zero lifecycle rows for the assertion it received via SWM.
    // Pin `?a` to OUR specific assertion (`KA` is unique per run) so unrelated
    // metadata on node2 can't satisfy this for the wrong reason.
    const r = await post(node2, '/api/query', {
      sparql:
        'PREFIX dkg: <http://dkg.io/ontology/> ' +
        `SELECT ?a ?state WHERE { ?a a dkg:Assertion ; dkg:state ?state . FILTER(CONTAINS(STR(?a), ${JSON.stringify(KA)})) }`,
      contextGraphId: CG,
      graphSuffix: '_meta',
    });
    const rows = r.body?.result?.bindings?.length ?? 0;
    expect(rows).toBeGreaterThan(0);
  });

  // CONTROL for #872 — proves the import fixture actually landed on node1, so a
  // red #872 below is the cross-node bug, not a broken import setup.
  it('CONTROL: node1 import-file fixture landed (fileHash + assertionUri captured)', () => {
    expect(importFileHash).not.toBe('');
    expect(importAssertionUri).not.toBe('');
  });

  it('GH #872: node2 (public-CG peer) can fetch the imported Markdown source bytes', async () => {
    const r = await post(node2, '/api/knowledge-assets/import-artifact/read-markdown', {
      contextGraphId: CG,
      assertionUri: importAssertionUri,
      fileHash: importFileHash,
    });
    expect(r.status).toBe(200);
    expect(String(r.body?.markdown ?? r.body)).toContain('Liveness Doc');
  });
});
