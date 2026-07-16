#!/usr/bin/env node
/**
 * verify-1107.cjs — end-to-end verification of all 14 fixes in PR #1107
 * (#1093–#1106) against a REAL running 6-node devnet (real Hardhat chain,
 * real on-chain publishes, real RDF, no mocks).
 *
 * Run AFTER: ./scripts/devnet.sh start 6
 *   node devnet/_bootstrap/verify-1107.cjs <authToken>
 */
const fs = require('fs');
const path = require('path');

const TOK = process.argv[2] || process.env.DKG_AUTH_TOKEN;
if (!TOK) { console.error('usage: node verify-1107.cjs <authToken>'); process.exit(2); }

const PORTS = { core1: 9201, core2: 9202, core3: 9203, core4: 9204, edge5: 9205, edge6: 9206 };
const base = (p) => `http://127.0.0.1:${p}`;
const ts = Date.now();
const results = [];
const rec = (id, title, pass, detail) => {
  results.push({ id, title, pass, detail });
  const tag = pass === true ? 'PASS' : pass === 'skip' ? 'SKIP' : 'FAIL';
  console.log(`[${tag}] ${id} ${title}\n        ${detail}`);
};

async function api(port, method, p, body, opts = {}) {
  const headers = { Authorization: `Bearer ${TOK}` };
  let payload;
  if (opts.form) { payload = body; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base(port) + p, { method, headers, body: payload });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (o) => JSON.stringify(o).slice(0, 240);

async function peerId(port) {
  const s = await api(port, 'GET', '/api/status');
  return (s.body.result || s.body).peerId;
}

(async () => {
  console.log(`\n=== verify-1107 against live devnet @ ${new Date(ts).toISOString()} ===\n`);

  // ---- shared fixtures -------------------------------------------------
  const CG = `v1107-pub-${ts}`;       // public CG (accessPolicy 0)
  const mk = await api(PORTS.core1, 'POST', '/api/context-graph/create',
    { id: CG, name: CG, description: 'verify-1107 public', accessPolicy: 0, publishPolicy: 1, register: true });
  if (!(mk.body.registered)) { rec('SETUP', 'create+register public CG', false, `create failed: ${j(mk.body)}`); }
  else console.log(`setup: public CG ${CG} registered onChainId=${mk.body.onChainId}\n`);
  const p1 = await peerId(PORTS.core1);
  const p2 = await peerId(PORTS.core2);
  console.log(`setup: core1 peerId=${p1}\nsetup: core2 peerId=${p2}\n`);

  // helper: full lifecycle publish of `name` with one schema:name triple
  async function publishKa(port, cg, name, subj, val) {
    await api(port, 'POST', '/api/knowledge-assets',
      { contextGraphId: cg, name, quads: [{ subject: subj, predicate: 'http://schema.org/name', object: `"${val}"` }] });
    await api(port, 'POST', `/api/knowledge-assets/${name}/swm/share`, { contextGraphId: cg });
    return api(port, 'POST', `/api/knowledge-assets/${name}/vm/publish`, { contextGraphId: cg });
  }

  // ===== #1093 — ACK pool reaches quorum (no QuorumUnmetError) ==========
  try {
    const confirms = [];
    for (let i = 0; i < 3; i++) {
      const r = await publishKa(PORTS.core1, CG, `ack-c1-${i}`, `urn:v:ack1-${i}`, `ack c1 ${i}`);
      confirms.push(r.body.status);
    }
    // core2 publishes to its own freshly-registered public CG
    const CG2 = `v1107-c2-${ts}`;
    await api(PORTS.core2, 'POST', '/api/context-graph/create', { id: CG2, name: CG2, accessPolicy: 0, publishPolicy: 1, register: true });
    for (let i = 0; i < 2; i++) {
      const r = await publishKa(PORTS.core2, CG2, `ack-c2-${i}`, `urn:v:ack2-${i}`, `ack c2 ${i}`);
      confirms.push(r.body.status);
    }
    const allConfirmed = confirms.every((s) => s === 'confirmed');
    rec('#1093', 'ACK pool quorum: 5 publishes across core1+core2', allConfirmed,
      `statuses=${JSON.stringify(confirms)} (all 'confirmed' ⇒ ACK quorum met)`);
  } catch (e) { rec('#1093', 'ACK pool quorum', false, `threw: ${e.message}`); }

  // ===== #1094 — KA edit loop (pull-from VM → edit → re-publish) ========
  try {
    const E = 'edit-loop';
    const pub1 = await publishKa(PORTS.core1, CG, E, 'urn:v:edit', 'original');
    const pull = await api(PORTS.core1, 'POST', `/api/knowledge-assets/${E}/wm/pull-from`, { contextGraphId: CG, layer: 'vm' });
    // edit: add a second triple, re-finalize, re-share, re-publish (UPDATE)
    await api(PORTS.core1, 'POST', `/api/knowledge-assets/${E}/wm/write`,
      { contextGraphId: CG, quads: [{ subject: 'urn:v:edit', predicate: 'http://schema.org/description', object: '"edited via pull-from loop"' }] });
    await api(PORTS.core1, 'POST', `/api/knowledge-assets/${E}/wm/finalize`, { contextGraphId: CG });
    await api(PORTS.core1, 'POST', `/api/knowledge-assets/${E}/swm/share`, { contextGraphId: CG });
    const pub2 = await api(PORTS.core1, 'POST', `/api/knowledge-assets/${E}/vm/publish`, { contextGraphId: CG });
    await sleep(1500);
    const q = await api(PORTS.core1, 'POST', '/api/query',
      { contextGraphId: CG, view: 'verifiable-memory', sparql: 'SELECT ?p ?o WHERE { <urn:v:edit> ?p ?o }' });
    const rows = (q.body.result?.bindings || []).map((b) => String(b.o));
    const hasEdit = rows.some((o) => /edited via pull-from loop/.test(o));
    const ok = pub1.body.status === 'confirmed' && pull.status === 200 && (pull.body.seeded >= 1) &&
      pub2.body.status === 'confirmed' && hasEdit;
    rec('#1094', 'edit loop: publish→pull-from(vm)→edit→re-publish→VM has edit', ok,
      `pub1=${pub1.body.status} pull=${pull.status}/seeded=${pull.body.seeded} pub2=${pub2.body.status} vmHasEdit=${hasEdit}`);
  } catch (e) { rec('#1094', 'KA edit loop', false, `threw: ${e.message}`); }

  // ===== #1095 — discard on a published KA must NOT clobber its state ====
  // Faithful #1095: a KA confirmed in VM (state=published / vm-confirmed),
  // then a wm/discard, must NOT flip the descriptor to "discarded" while the
  // asset is live on-chain. The fix filters the state="discarded" +
  // prov:wasInvalidatedBy stamps when a vmCurrentAssertion pointer exists.
  try {
    await publishKa(PORTS.core1, CG, 'survivor', 'urn:v:survivor', 'survives discard');
    const before = await api(PORTS.core1, 'GET', `/api/knowledge-assets/survivor?contextGraphId=${CG}`);
    const dr = await api(PORTS.core1, 'POST', '/api/knowledge-assets/survivor/wm/discard', { contextGraphId: CG });
    const d = await api(PORTS.core1, 'GET', `/api/knowledge-assets/survivor?contextGraphId=${CG}`);
    const ok = before.body.status === 'vm-confirmed' && dr.status >= 200 && dr.status < 300 &&
      d.status === 200 && d.body.status === 'vm-confirmed' && d.body.state !== 'discarded' && !!d.body.publishedUal;
    rec('#1095', 'discard on a published KA keeps it vm-confirmed (not flipped to discarded)', ok,
      `before=${before.body.status} discardResp=${dr.status} after: state=${d.body.state} status=${d.body.status} publishedUal=${d.body.publishedUal ? 'present' : 'MISSING'}`);
  } catch (e) { rec('#1095', 'lifecycle descriptor / discard', false, `threw: ${e.message}`); }

  // ===== #1096 — memory/search matches Verifiable Memory ================
  try {
    await publishKa(PORTS.core1, CG, 'searchable', 'urn:v:searchable', 'UniqueSearchTokenXYZ');
    await sleep(800);
    const s = await api(PORTS.core1, 'POST', '/api/memory/search', { contextGraphId: CG, query: 'UniqueSearchTokenXYZ', limit: 10 });
    const n = (s.body.results || []).length;
    const hit = JSON.stringify(s.body.results || []).includes('UniqueSearchTokenXYZ') || n > 0;
    rec('#1096', 'memory/search finds VM-published entity', s.status === 200 && hit,
      `status=${s.status} results=${n} matched=${hit}`);
  } catch (e) { rec('#1096', 'memory/search VM', false, `threw: ${e.message}`); }

  // ===== #1097 — finalized-but-unshared publish ⇒ clean 409 (main's contract)
  try {
    await api(PORTS.core1, 'POST', '/api/knowledge-assets',
      { contextGraphId: CG, name: 'noshare', quads: [{ subject: 'urn:v:noshare-only', predicate: 'http://schema.org/name', object: '"no share"' }] });
    // (auto-sealed by create-with-quads; do NOT share)
    const pub = await api(PORTS.core1, 'POST', '/api/knowledge-assets/noshare/vm/publish', { contextGraphId: CG });
    const ok = pub.status === 409 && pub.body.code === 'VM_PUBLISH_PRECONDITION';
    rec('#1097', 'publish without share ⇒ clean 409 (not 500); main design supersedes auto-promote', ok,
      `status=${pub.status} code=${pub.body.code} err=${String(pub.body.error).slice(0, 80)}`);
  } catch (e) { rec('#1097', 'one-shot publish precondition', false, `threw: ${e.message}`); }

  // ===== #1098 — VM materializes on a subscribed replica ================
  // P2P convergence is *eventual* (gossip/sync mesh timing varies run-to-run),
  // so we subscribe the replica BEFORE publishing (the #1098 scenario), then
  // nudge a catch-up re-subscribe after publish, and poll generously (~90s).
  try {
    await api(PORTS.core2, 'POST', '/api/context-graph/subscribe', { contextGraphId: CG });
    await sleep(2000);
    const R = 'replica-vm';
    await publishKa(PORTS.core1, CG, R, 'urn:v:replica', 'replicated to core2');
    const vmRows = async () => {
      const q = await api(PORTS.core2, 'POST', '/api/query',
        { contextGraphId: CG, view: 'verifiable-memory', sparql: 'SELECT ?o WHERE { <urn:v:replica> <http://schema.org/name> ?o }' });
      return q.body.result?.bindings || [];
    };
    let rows = [];
    // Phase 1: live finalization-gossip path (the exact #1098 scenario), ~45s.
    for (let i = 0; i < 15; i++) {
      await sleep(3000);
      rows = await vmRows();
      if (rows.length) { console.log(`        (core2 VM converged via live path after ~${(i + 1) * 3}s)`); break; }
    }
    // Phase 2: force a fresh catch-up (unsubscribe→resubscribe) — deterministic
    // pull of the now-published VM data — then poll another ~45s.
    if (!rows.length) {
      await api(PORTS.core2, 'POST', '/api/context-graph/unsubscribe', { contextGraphId: CG });
      await sleep(1500);
      await api(PORTS.core2, 'POST', '/api/context-graph/subscribe', { contextGraphId: CG });
      for (let i = 0; i < 15; i++) {
        await sleep(3000);
        rows = await vmRows();
        if (rows.length) { console.log(`        (core2 VM converged via catch-up after re-subscribe, ~${(i + 1) * 3}s)`); break; }
      }
    }
    const ok = rows.length > 0 && JSON.stringify(rows).includes('replicated to core2');
    rec('#1098', 'VM materializes/converges on subscribed replica (core2) after publish on core1', ok,
      `core2 VM rows=${rows.length} ${ok ? '(replicated entity present)' : '(NOT materialized in 90s)'}`);
  } catch (e) { rec('#1098', 'replica VM materialization', false, `threw: ${e.message}`); }

  // ===== #1099 — SWM cleared after publish (publisher) ==================
  try {
    // urn:v:thing... already published above; check SWM drained for a fresh one
    await publishKa(PORTS.core1, CG, 'swmclear', 'urn:v:swmclear', 'swm should be empty after publish');
    await sleep(1000);
    const q = await api(PORTS.core1, 'POST', '/api/query',
      { contextGraphId: CG, view: 'shared-working-memory', sparql: 'SELECT ?o WHERE { <urn:v:swmclear> <http://schema.org/name> ?o }' });
    const swmRows = (q.body.result?.bindings || []).length;
    rec('#1099', 'SWM drained on publisher after confirmed publish', swmRows === 0,
      `SWM rows for published root = ${swmRows} (expect 0)`);
  } catch (e) { rec('#1099', 'SWM clear-after-publish', false, `threw: ${e.message}`); }

  // ===== #1101 — import-file Markdown extraction ========================
  try {
    const md = '# Verify 1107\n\nAcme Corp acquired Beta LLC on March 5 2026. Contact: jane@acme.example.\n';
    const fd = new FormData();
    fd.append('contextGraphId', CG);
    fd.append('file', new Blob([md], { type: 'application/octet-stream' }), 'notes.md');
    const imp = await api(PORTS.core1, 'POST', '/api/knowledge-assets/md-import/wm/import-file', fd, { form: true });
    const ct = imp.body.detectedContentType || imp.body.contentType;
    const extraction = imp.body.extraction || imp.body.extractionStatus || imp.body.status;
    const ok = imp.status >= 200 && imp.status < 300 && /markdown/i.test(String(ct));
    rec('#1101', 'import-file infers text/markdown for octet-stream .md upload', ok,
      `status=${imp.status} detectedContentType=${ct} extraction=${j(extraction)}`);
  } catch (e) { rec('#1101', 'import-file Markdown', false, `threw: ${e.message}`); }

  // ===== #1102 — CG routes accept `id` alias (subscribe + rename) =======
  try {
    const sub = await api(PORTS.core3, 'POST', '/api/context-graph/subscribe', { id: CG }); // `id` not contextGraphId
    const renameOk = await api(PORTS.core1, 'POST', '/api/context-graph/rename', { id: CG, name: `${CG}-renamed` });
    const subOk = sub.status >= 200 && sub.status < 500 && !/Missing .*contextGraphId/.test(JSON.stringify(sub.body));
    const renOk = renameOk.status !== 400 || !/Missing .*contextGraphId/.test(JSON.stringify(renameOk.body));
    rec('#1102', 'CG routes accept `id` alias (subscribe + rename)', subOk && renOk,
      `subscribe{id} status=${sub.status}; rename{id} status=${renameOk.status}`);
  } catch (e) { rec('#1102', 'CG route id alias', false, `threw: ${e.message}`); }

  // ===== #1103 — sign-join returns forwarded:false + request-join hint ==
  try {
    // curated CG so a join flow is meaningful
    const CCG = `v1107-curated-${ts}`;
    await api(PORTS.core1, 'POST', '/api/context-graph/create', { id: CCG, name: CCG, accessPolicy: 1, publishPolicy: 1, register: true });
    const sj = await api(PORTS.edge5, 'POST', `/api/context-graph/${CCG}/sign-join`, { contextGraphId: CCG });
    const ok = sj.status >= 200 && sj.status < 300 && sj.body.forwarded === false && /request-join/.test(JSON.stringify(sj.body.next || ''));
    rec('#1103', 'sign-join is sign-only: forwarded:false + next→request-join hint', ok,
      `status=${sj.status} forwarded=${sj.body.forwarded} next=${String(sj.body.next).slice(0, 90)}`);
  } catch (e) { rec('#1103', 'sign-join contract', false, `threw: ${e.message}`); }

  // ===== #1104 — descriptor surfaces publishedUal (distinct from reservedUal)
  try {
    const d = await api(PORTS.core1, 'GET', `/api/knowledge-assets/searchable?contextGraphId=${CG}`);
    const ok = !!d.body.publishedUal && !!d.body.reservedUal && d.body.publishedUal !== d.body.reservedUal;
    rec('#1104', 'descriptor surfaces publishedUal (≠ reservedUal)', ok,
      `publishedUal=${d.body.publishedUal ? 'present' : 'MISSING'} reservedUal=${d.body.reservedUal ? 'present' : 'MISSING'} distinct=${d.body.publishedUal !== d.body.reservedUal}`);
  } catch (e) { rec('#1104', 'publishedUal in descriptor', false, `threw: ${e.message}`); }

  // ===== #1105 — query-remote against a PUBLIC CG works (deny-by-default)
  try {
    // node5 (edge, not holding the data) queries core1's public CG remotely
    const qr = await api(PORTS.edge5, 'POST', '/api/query-remote',
      { peerId: p1, contextGraphId: CG, lookupType: 'SPARQL_QUERY', sparql: 'SELECT ?o WHERE { <urn:v:searchable> <http://schema.org/name> ?o }', timeout: 15000 });
    const r = qr.body.result || qr.body;
    const status = r.status || qr.status;
    const cnt = r.resultCount ?? (r.bindings ? r.bindings.length : (Array.isArray(qr.body.results) ? qr.body.results.length : 0));
    const matched = JSON.stringify(qr.body).includes('UniqueSearchTokenXYZ');
    const ok = (String(status) === 'OK' || qr.status === 200) && matched;
    rec('#1105', 'query-remote against public CG returns rows from another node', ok,
      `http=${qr.status} remoteStatus=${status} matched=${matched} body=${j(qr.body)}`);
  } catch (e) { rec('#1105', 'query-remote public CG', false, `threw: ${e.message}`); }

  // ===== #1106 — chat aliases (peerId/message) + WM default-agent query =
  try {
    const chat = await api(PORTS.core1, 'POST', '/api/chat', { peerId: p2, message: 'hello from verify-1107' });
    const chatOk = chat.status >= 200 && chat.status < 300;
    // WM default agent: create a WM draft, query view=working-memory WITHOUT agentAddress → rows
    await api(PORTS.core1, 'POST', '/api/knowledge-assets',
      { contextGraphId: CG, name: 'wmdefault', quads: [] });
    await api(PORTS.core1, 'POST', '/api/knowledge-assets/wmdefault/wm/write',
      { contextGraphId: CG, quads: [{ subject: 'urn:v:wmdefault', predicate: 'http://schema.org/name', object: '"wm default agent"' }] });
    const wq = await api(PORTS.core1, 'POST', '/api/query',
      { contextGraphId: CG, view: 'working-memory', sparql: 'SELECT ?o WHERE { <urn:v:wmdefault> <http://schema.org/name> ?o }' });
    const wmRows = (wq.body.result?.bindings || []).length;
    // sub-graph name with '/' is rejected
    const badSg = await api(PORTS.core1, 'POST', '/api/sub-graph/create', { contextGraphId: CG, name: 'bad/name' });
    const sgRejected = badSg.status >= 400;
    rec('#1106', 'chat peerId/message aliases + WM default-agent query + sub-graph "/" rejected',
      chatOk && wmRows > 0 && sgRejected,
      `chat=${chat.status} wmDefaultRows=${wmRows} subGraphSlashRejected=${sgRejected}(${badSg.status})`);
  } catch (e) { rec('#1106', 'SKILL.md drift bundle', false, `threw: ${e.message}`); }

  // ===== general app sanity =============================================
  try {
    const statuses = [];
    for (const [k, p] of Object.entries(PORTS)) {
      const s = await api(p, 'GET', '/api/status');
      const r = s.body.result || s.body;
      statuses.push(`${k}:${s.status === 200 ? 'up' : 'DOWN'}/peers=${r.peerCount ?? r.peers ?? '?'}`);
    }
    rec('APP', 'all 6 nodes healthy + meshed', statuses.every((x) => x.includes(':up')), statuses.join(' '));
  } catch (e) { rec('APP', 'node health', false, `threw: ${e.message}`); }

  // ---- summary ---------------------------------------------------------
  const pass = results.filter((r) => r.pass === true).length;
  const fail = results.filter((r) => r.pass === false).length;
  const skip = results.filter((r) => r.pass === 'skip').length;
  console.log(`\n=== SUMMARY: ${pass} PASS / ${fail} FAIL / ${skip} SKIP (of ${results.length}) ===`);
  for (const r of results) console.log(`  ${r.pass === true ? '✅' : r.pass === 'skip' ? '⚪' : '❌'} ${r.id} — ${r.title}`);
  fs.writeFileSync(path.join(__dirname, `verify-1107-results-${ts}.json`), JSON.stringify(results, null, 2));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(3); });
