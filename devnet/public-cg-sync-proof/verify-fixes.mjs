#!/usr/bin/env node
/**
 * End-to-end verification of the two fixes in v10.0.9, on a live devnet.
 *
 * These are verified by BEHAVIOUR, not by reading their diffs — both are bugs
 * whose whole character is "the write succeeds and the peer ends up with the
 * wrong thing", which a unit test on the author side cannot observe.
 *
 *   #1779  Markdown KA visibility after SWM sharing.
 *          Markdown headings import as blank-node section entities, canonicalized
 *          at finalization to urn:dkg:ka-skolem:c14n0. The receiving SWM validator
 *          treated those protocol-generated identifiers as user-authored reserved
 *          terms and rejected ALL content triples, leaving the KA visible on peers
 *          with operation/assertion metadata but EMPTY entities and triples.
 *          => Assert a peer sees the actual content triples, not just metadata.
 *
 *   #1780  Curator VM-publish of a member-shared rootless root.
 *          Defect A: the seal-lookup URI was built from the CURATOR's address while
 *          the member's seal lives at .../assertion/<member>/<name> -> 409
 *          "is not finalized". Defect B: durable sync's integrity filter dropped
 *          dkg:assertionVersion, delivering 13 of 14 seal quads.
 *          => Assert a member shares, and a DIFFERENT agent (the curator) can
 *             VM-publish that member's asset successfully.
 *
 * Usage: node devnet/public-cg-sync-proof/verify-fixes.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const DEVNET_DIR = process.env.DEVNET_DIR || join(REPO, '.devnet-1009');
const PORT_BASE = Number(process.env.API_PORT_BASE || 9400);
const nodeUrl = (n) => `http://127.0.0.1:${PORT_BASE + n - 1}`;

function adminToken() {
  const p = join(DEVNET_DIR, 'node1', 'auth.token');
  if (!existsSync(p)) throw new Error(`no devnet auth token at ${p}`);
  return readFileSync(p, 'utf-8').split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#')).pop();
}

async function api(node, path, { method = 'GET', bearer, body, timeoutMs = 180_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${nodeUrl(node)}${path}`, {
      method, signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
    return { ok: res.ok, status: res.status, json };
  } finally { clearTimeout(t); }
}

/** POST /api/knowledge-assets/:name/wm/import-file — multipart/form-data. */
async function importFile(node, name, bearer, contextGraphId, fileName, content) {
  const fd = new FormData();
  fd.set('file', new Blob([content], { type: 'text/markdown' }), fileName);
  fd.set('contextGraphId', contextGraphId);
  const res = await fetch(`${nodeUrl(node)}/api/knowledge-assets/${encodeURIComponent(name)}/wm/import-file`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}` }, // no Content-Type: fetch sets the multipart boundary
    body: fd,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, json };
}

/**
 * A CG is "known" as soon as it is registered, but writes are refused until it
 * is locally synced (CONTEXT_GRAPH_NOT_WRITABLE). Subscribing only *queues* the
 * catch-up, so a write issued immediately after subscribe races it.
 */
/**
 * Retry the actual write until the CG becomes writable. Probing a status field
 * is unreliable here: `subscribed` flips true the instant subscribe returns,
 * while writes stay refused (CONTEXT_GRAPH_NOT_WRITABLE) until catch-up has
 * actually synced the graph. The write itself is the only honest readiness
 * signal, so retry it rather than guess from metadata.
 */
async function writeWhenWritable(node, path, bearer, body, budgetMs = 120_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < budgetMs) {
    const r = await api(node, path, { method: 'POST', bearer, body });
    if (r.ok) return { ...r, waitedMs: Date.now() - start };
    last = r;
    if (r.json?.code !== 'CONTEXT_GRAPH_NOT_WRITABLE') return { ...r, waitedMs: Date.now() - start };
    await new Promise((res) => setTimeout(res, 3000));
  }
  return { ...(last ?? { ok: false, status: 0, json: {} }), waitedMs: Date.now() - start };
}

async function sparql(node, bearer, query) {
  const r = await api(node, '/api/query', { method: 'POST', bearer, body: { sparql: query }, timeoutMs: 60_000 });
  if (!r.ok) throw new Error(`sparql node${node}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json?.result?.bindings ?? [];
}

async function waitFor(fn, budgetMs = 90_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < budgetMs) {
    try { last = await fn(); if (last?.done) return { ...last, waitedMs: Date.now() - start }; }
    catch (e) { last = { done: false, note: e.message }; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ...(last ?? {}), done: false, waitedMs: Date.now() - start };
}

const results = [];
function record(check, pass, detail) {
  results.push({ check, pass, detail });
  console.log(`[${pass === true ? 'PASS' : pass === false ? 'FAIL' : 'INFO'}] ${check}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const stamp = Date.now();
  const TOK = adminToken();
  console.log(`# v10.0.9 fix verification  stamp=${stamp}`);

  const mkAgent = async (node, label) => {
    const r = await api(node, '/api/agent/register', {
      method: 'POST', bearer: TOK, body: { name: `fx-${label}-${stamp}`, framework: 'verify-fixes' },
    });
    if (!r.ok) throw new Error(`register ${label}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    return { node, address: r.json.agentAddress, token: r.json.authToken };
  };

  // =====================================================================
  // #1779 — Markdown KA content must reach a peer, not just its metadata
  // =====================================================================
  {
    const author = await mkAgent(1, 'md-author');
    const peer = await mkAgent(2, 'md-peer');
    const cgId = `${author.address}/fx-md-${stamp}`;

    const create = await api(1, '/api/context-graph/create', {
      method: 'POST', bearer: author.token,
      body: { id: cgId, name: `FX md ${stamp}`, accessPolicy: 0, publishPolicy: 1, register: true },
    });
    record('#1779: CG registered', Boolean(create.ok && create.json.registered),
      create.json?.onChainId ? `onChainId=${create.json.onChainId}` : JSON.stringify(create.json).slice(0, 160));

    await api(2, '/api/context-graph/subscribe', {
      method: 'POST', bearer: peer.token, body: { contextGraphId: cgId },
    });

    // A Markdown document with headings — the exact shape that produced
    // blank-node section entities and triggered the skolem-ID rejection.
    const markdown = [
      `# Release ${stamp}`, '',
      'Intro paragraph for the release note.', '',
      '## Sync', '',
      'Public context graphs converge on both SWM and VM.', '',
      '## Notes', '',
      'Second section body text.', '',
    ].join('\n');

    // Route is POST /api/knowledge-assets/:name/wm/import-file and takes
    // multipart/form-data — not the legacy JSON /api/assertion/:name/import-file.
    const name = `fx-md-${stamp}`;
    const imp = await importFile(1, name, author.token, cgId, `${name}.md`, markdown);
    if (!imp.ok) {
      record('#1779: markdown imported', false, `${imp.status} ${JSON.stringify(imp.json).slice(0, 240)}`);
    } else {
      record('#1779: markdown imported', true, `${imp.json?.written ?? '?'} quads written`);

      const share = await api(1, `/api/knowledge-assets/${encodeURIComponent(name)}/swm/share`, {
        method: 'POST', bearer: author.token, body: { contextGraphId: cgId },
      });
      record('#1779: author shared markdown KA to SWM', share.ok,
        share.ok ? `status=${share.json?.status ?? 'ok'}` : JSON.stringify(share.json).slice(0, 200));

      // The bug's signature: peer has metadata but ZERO content triples.
      // So count CONTENT triples specifically — those carrying the heading text.
      // Markdown import skolemizes subjects (urn:dkg:ka-skolem:cN), so they cannot
      // be bound with VALUES the way the scale/hold-out counts are.
      // Must match ONLY imported markdown body text. The previous filter also
      // matched anything carrying the run stamp — including the context graph's
      // own name literal ("FX md <stamp>") — so it could report
      // "PEER sees markdown CONTENT triples" while the peer had received
      // metadata and zero imported content: exactly the #1779 signature this
      // check exists to detect. Bind distinctive body strings that appear only
      // in the document, and exclude the CG/operation metadata graphs.
      // sparql-scan-allow: R2 -- devnet-only harness, never run by node runtime; one
      // purpose-built devnet store holding only this run's fixtures
      const contentQuery = `SELECT (COUNT(*) AS ?n) WHERE {
        GRAPH ?g { ?s ?p ?o }
        FILTER(CONTAINS(STR(?g), "fx-md-${stamp}"))
        FILTER(!CONTAINS(STR(?g), "_meta"))
        FILTER(isLiteral(?o) && (
          CONTAINS(STR(?o), "Intro paragraph for the release note")
          || CONTAINS(STR(?o), "Public context graphs converge on both SWM and VM")
          || CONTAINS(STR(?o), "Second section body text")
        ))
      }`;
      const onPeer = await waitFor(async () => {
        const b = await sparql(2, peer.token, contentQuery);
        const n = Number(String(b[0]?.n ?? '0').replace(/"/g, '').split('^')[0]) || 0;
        return { done: n > 0, observed: n };
      });
      record('#1779: PEER sees markdown CONTENT triples (not just metadata)',
        onPeer.done === true,
        onPeer.done
          ? `${onPeer.observed} content triples on peer in ${onPeer.waitedMs}ms`
          : `EMPTY on peer after ${onPeer.waitedMs}ms — this is the #1779 signature`);

      // Cross-check total graph population, author vs peer.
      // sparql-scan-allow: R2 -- same devnet-only harness scope as above; this is the
      // author-vs-peer population cross-check for one freshly created CG.
      const totalQ = `SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), "fx-md-${stamp}")) }`;
      const aN = Number(String((await sparql(1, author.token, totalQ))[0]?.n ?? '0').replace(/"/g, '').split('^')[0]) || 0;
      const pN = Number(String((await sparql(2, peer.token, totalQ))[0]?.n ?? '0').replace(/"/g, '').split('^')[0]) || 0;
      record('#1779: peer graph population is comparable to author',
        pN > 0 && pN >= Math.floor(aN * 0.5),
        `author=${aN} quads, peer=${pN} quads`);
    }
  }

  // =====================================================================
  // #1780 — a curator must be able to VM-publish a MEMBER's shared root
  // =====================================================================
  {
    const curator = await mkAgent(1, 'curator');
    const member = await mkAgent(2, 'member');
    const cgId = `${curator.address}/fx-cur-${stamp}`;

    const create = await api(1, '/api/context-graph/create', {
      method: 'POST', bearer: curator.token,
      body: { id: cgId, name: `FX curated ${stamp}`, accessPolicy: 0, publishPolicy: 0, register: true },
    });
    record('#1780: curated CG registered', Boolean(create.ok && create.json.registered),
      create.json?.onChainId ? `onChainId=${create.json.onChainId}` : JSON.stringify(create.json).slice(0, 200));

    // The member must be inside the CG's AGENT GATE to gossip SWM writes.
    // Creating a curated CG stamps only the curator into allowedAgents, and
    // resolveWorkspaceGossipSigningAgent (dkg-agent-crypto.ts:2505) refuses a
    // gossip write when no local agent key is in that set. Contrary to the
    // RFC-64 framing, a curated CG gates SWM submission too — not just VM
    // admission — so "member shares, curator publishes" requires this step.
    const addP = await api(1, `/api/context-graph/${encodeURIComponent(cgId)}/add-participant`, {
      method: 'POST', bearer: curator.token, body: { agentAddress: member.address },
    });
    record('#1780: member added to the CG agent gate', addP.ok,
      addP.ok ? `participant ${member.address.slice(0, 10)}…` : `${addP.status} ${JSON.stringify(addP.json).slice(0, 200)}`);

    await api(2, '/api/context-graph/subscribe', {
      method: 'POST', bearer: member.token, body: { contextGraphId: cgId },
    });

    // MEMBER authors and shares into SWM (now inside the agent gate).
    const kaName = `fx-member-ka-${stamp}`;
    const subject = `urn:fx:${stamp}:member`;
    const graph = `did:dkg:context-graph:${cgId}`;
    const shared = await writeWhenWritable(2, '/api/knowledge-assets', member.token, {
      name: kaName, contextGraphId: cgId, alsoShareSwm: true,
      quads: [
        { subject, predicate: 'https://schema.org/name', object: `"MemberAsset-${stamp}"`, graph },
        { subject, predicate: 'https://schema.org/description', object: '"shared by member, published by curator"', graph },
      ],
    });
    record('#1780: MEMBER shared an asset into SWM', shared.ok,
      shared.ok
        ? `status=${shared.json?.status} (writable after ${shared.waitedMs}ms)`
        : `${shared.json?.code ?? shared.status} after ${shared.waitedMs}ms: ${JSON.stringify(shared.json).slice(0, 200)}`);

    // Wait for the curator's node to actually hold the member's shared asset.
    const seen = await waitFor(async () => {
      const b = await sparql(1, curator.token,
        `SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { <${subject}> ?p ?o } }`);
      const n = Number(String(b[0]?.n ?? '0').replace(/"/g, '').split('^')[0]) || 0;
      return { done: n > 0, observed: n };
    });
    record('#1780: curator node received the member-shared asset', seen.done === true,
      seen.done ? `${seen.observed} quads` : `not visible after ${seen.waitedMs}ms`);

    // THE FIX: the curator VM-publishes the MEMBER's asset. Pre-#1780 this
    // failed 409 "is not finalized" because the seal URI was built from the
    // curator's address instead of the member's.
    const pub = await api(1, `/api/knowledge-assets/${encodeURIComponent(kaName)}/vm/publish`, {
      method: 'POST', bearer: curator.token, body: { contextGraphId: cgId, agentAddress: member.address },
    });
    const confirmed = pub.ok && pub.json?.status === 'confirmed';
    record('#1780: CURATOR VM-published the MEMBER-shared root',
      confirmed,
      confirmed
        ? `confirmed, block=${pub.json.blockNumber}, ual=${String(pub.json.ual).slice(0, 60)}`
        : `http=${pub.status} ${JSON.stringify(pub.json).slice(0, 260)}`);
  }

  const passed = results.filter((r) => r.pass === true).length;
  const failed = results.filter((r) => r.pass === false);
  console.log(`\n=== ${passed}/${results.filter((r) => typeof r.pass === 'boolean').length} checks passed ===`);
  for (const f of failed) console.log(`  FAILED: ${f.check} — ${f.detail}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(`FATAL: ${e.stack || e.message}`); process.exit(2); });
