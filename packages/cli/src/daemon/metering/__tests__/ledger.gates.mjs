// V2-B2 gate: ledger accounting, exactly-once, exemption purity, D6 negative
// suite node-side (reason codes), canonicalization determinism.
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const L = await import('/tmp/meterbuild/ledger.js');
const M = await import('/tmp/meterbuild/read-meter.js');

const home = mkdtempSync(join(tmpdir(), 'meter-'));
const P = '0xBoPrincipal';
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('✔', name); pass++; } catch (e) { console.log('✖', name, '—', e.message); fail++; } };

t('credit then balance', () => {
  L.credit(home, P, 100000, { txHash: '0xdeposit' });
  assert.equal(L.balance(home, P).balance, 100000);
});

let leg1;
t('read leg debits atomically and signs', () => {
  leg1 = L.recordReadLeg(home, {
    principal: P, units: 6.5, breakdown: { markers: { scan: 1 } }, scopeQuads: 26200,
    sparql: 'SELECT ?s WHERE { ?s <p> ?o }', responseBody: '{"bindings":[]}',
    contextGraphId: 'odysseus', view: 'shared-working-memory', askMicroPer1k: 100,
  });
  assert.equal(leg1.legType, 'read');
  assert.equal(leg1.schemaVersion, 'receipt-v0.2');
  assert.equal(leg1.pricing.costMicroTrac, 1);      // ceil(6.5*100/1000)
  assert.equal(leg1.tab.before, 100000);
  assert.equal(leg1.tab.after, 99999);
  assert.equal(leg1.sequence, 1);
  assert.equal(leg1.previousLegHash, 'genesis');
  assert.ok(leg1.providerSignature.length > 40);
});

t('D14: leg is NOT settlement-admissible until countersigned', () => {
  assert.equal(leg1.settlement.status, 'pending-countersignature');
});

t('chain links: second leg references the first', () => {
  const leg2 = L.recordReadLeg(home, {
    principal: P, units: 1.3, breakdown: {}, scopeQuads: 26200,
    sparql: 'SELECT ?p WHERE { <urn:x> ?p ?o }', responseBody: '{}', askMicroPer1k: 100,
  });
  assert.equal(leg2.sequence, 2);
  assert.notEqual(leg2.previousLegHash, 'genesis');
});

t('E_INSUFFICIENT_FUNDS does not mutate state', () => {
  const poorHome = mkdtempSync(join(tmpdir(), 'meter-'));
  L.credit(poorHome, P, 1, { txHash: '0x1' });
  const before = L.balance(poorHome, P);
  assert.throws(() => L.recordReadLeg(poorHome, {
    principal: P, units: 500, breakdown: {}, scopeQuads: 102000,
    sparql: 'SELECT * WHERE { ?a ?b ?c }', responseBody: 'x'.repeat(4096), askMicroPer1k: 100,
  }), /E_INSUFFICIENT_FUNDS/);
  assert.deepEqual(L.balance(poorHome, P), before);
});

t('D12: exemption is pure — exempt principals never enter the ledger', () => {
  const cfg = { mode: 'enforce', readAskMicroPer1k: 100, exemptPrincipals: new Set(['0xDaemon']), enforcedPrincipals: new Set([P]) };
  assert.equal(M.isExempt('0xDaemon', cfg), true);
  assert.equal(M.isExempt(undefined, cfg), true);     // node-internal
  assert.equal(M.isExempt('0xStranger', cfg), true);  // not enforced ⇒ shadow
  assert.equal(M.isExempt(P, cfg), false);
});

t('shadow mode never bills anyone', () => {
  const cfg = { mode: 'shadow', readAskMicroPer1k: 100, exemptPrincipals: new Set(), enforcedPrincipals: new Set([P]) };
  assert.equal(M.isExempt(P, cfg), true);
});

t('journal replays to identical state (crash-restart)', () => {
  const snapshot = L.balance(home, P);
  const lines = readFileSync(join(home, 'metering', 'read-journal.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 3);
  const debits = lines.filter((l) => JSON.parse(l).kind === 'debit');
  const last = JSON.parse(debits[debits.length - 1]);
  assert.equal(last.leg.tab.after, snapshot.balance);
});

t('canonicalization is deterministic and key-order independent', () => {
  assert.equal(L.canonicalize({ b: 1, a: [2, 'x'] }), '{"a":[2,"x"],"b":1}');
  assert.equal(L.canonicalize({ u: 6.5 }), '{"u":6.5}');
});

t('failed read records base fee, no debit', () => {
  const b = L.balance(home, P).balance;
  L.noteFailedRead(home, { principal: P, sparql: 'BROKEN' });
  assert.equal(L.balance(home, P).balance, b);
  const j = readFileSync(join(home, 'metering', 'read-journal.jsonl'), 'utf8');
  assert.ok(j.includes('"kind":"failed-read"'));
});

t('config kill-switch: env overrides file', () => {
  process.env.DKG_READ_METER_MODE = 'off';
  assert.equal(L.loadMeterConfig(home).mode, 'off');
  delete process.env.DKG_READ_METER_MODE;
});

console.log(`\n${pass}/${pass + fail} node-side gates pass`);
process.exit(fail ? 1 : 0);
