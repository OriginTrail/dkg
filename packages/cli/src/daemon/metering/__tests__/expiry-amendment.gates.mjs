// Gates for Bo's amendment: no debit after expiry; idempotent, observable refund.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const D = await import('/tmp/meterbuild/deposit-rail.js');
const L = await import('/tmp/meterbuild/ledger.js');

const home = mkdtempSync(join(tmpdir(), 'b3x-'));
const BO = '0x8A87ea7c0fBC3431f20B5B26dd9f7f32571Aa2ba';
const terms = { termsVersion: 'tab-terms/v1', chain: 'base:8453', tracContract: '0xA81a', providerAddress: '0x633E',
  refundAddress: BO, confirmationDepth: 12, minimumCreditTrac: '1', expiryMs: 30*60*1000,
  rolloverPolicy: 'none', refundOnExpiry: true, askMicroPer1k: 100, scheduleVersion: 'read-schedule/1.0-provisional' };
const NOW = Date.now();
const art = D.registerOpening(home, D.buildOpeningArtifact(BO, terms, NOW));
L.setDebitGate((h, p, now) => D.debitAllowed(h, p, now));
L.credit(home, BO, 1_000_000, { kind: 'trac-deposit' });

let pass=0, fail=0;
const t=(n,fn)=>{try{fn();console.log('✔',n);pass++;}catch(e){console.log('✖',n,'—',e.message);fail++;}};

t('debit allowed while the tab is live', () => {
  const leg = L.recordReadLeg(home, { principal: BO, units: 10, breakdown: {}, scopeQuads: 26200,
    sparql: 'SELECT ?s WHERE { ?s ?p ?o }', responseBody: '{}', askMicroPer1k: 100 });
  assert.equal(leg.tab.after, 1_000_000 - 1);
});

t('Bo: NO debit path after expiry', () => {
  const expired = D.registerOpening(home, D.buildOpeningArtifact(BO, { ...terms, expiryMs: 1 }, NOW - 60_000));
  assert.equal(D.debitAllowed(home, BO).ok, false);
  assert.throws(() => L.recordReadLeg(home, { principal: BO, units: 10, breakdown: {}, scopeQuads: 26200,
    sparql: 'SELECT ?s WHERE { ?s ?p ?o }', responseBody: '{}', askMicroPer1k: 100 }), /E_TAB_EXPIRED/);
});

t('unknown principal cannot debit (no open tab)', () => {
  assert.equal(D.debitAllowed(home, '0xnobody').code, 'E_NO_OPEN_TAB');
});

let first;
t('Bo: refund is observable — one journal record with address + digest', () => {
  first = L.refundOnExpiry(home, BO, BO, art.termsDigest);
  assert.equal(first.alreadyRefunded, false);
  assert.ok(first.refundedMicroTrac > 0);
  const j = readFileSync(join(home, 'metering', 'read-journal.jsonl'), 'utf8');
  assert.ok(j.includes('"kind":"refund"') && j.includes(BO) && j.includes(art.termsDigest));
});

t('Bo: refund is IDEMPOTENT — repeat is a no-op, balance stays zero', () => {
  const again = L.refundOnExpiry(home, BO, BO, art.termsDigest);
  assert.equal(again.alreadyRefunded, true);
  assert.equal(again.refundedMicroTrac, first.refundedMicroTrac);
  assert.equal(L.balance(home, BO).balance, 0);
  const n = readFileSync(join(home, 'metering', 'read-journal.jsonl'), 'utf8').split('\n').filter(l => l.includes('"kind":"refund"')).length;
  assert.equal(n, 1, `expected exactly 1 refund record, found ${n}`);
});

t('Bo: a later payment requires a NEW tab and digest', () => {
  const fresh = D.registerOpening(home, D.buildOpeningArtifact(BO, { ...terms, expiryMs: 30*60*1000 }, Date.now()));
  assert.notEqual(fresh.termsDigest, undefined);
  assert.equal(D.debitAllowed(home, BO).ok, true);
  L.credit(home, BO, 500_000, { kind: 'trac-deposit', note: 'new tab' });
  const leg = L.recordReadLeg(home, { principal: BO, units: 10, breakdown: {}, scopeQuads: 26200,
    sparql: 'SELECT ?s WHERE { ?s ?p ?o }', responseBody: '{}', askMicroPer1k: 100 });
  assert.equal(leg.tab.before, 500_000);
});

console.log(`\n${pass}/${pass+fail} expiry-amendment gates pass`);
process.exit(fail?1:0);
