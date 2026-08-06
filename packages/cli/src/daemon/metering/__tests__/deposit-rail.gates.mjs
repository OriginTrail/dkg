// V2-B3 gates — every case is one of Bo's binding terms, tested as a rule.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const D = await import('/tmp/meterbuild/deposit-rail.js');
const L = await import('/tmp/meterbuild/ledger.js');

const home = mkdtempSync(join(tmpdir(), 'b3-'));
const BO = '0x8A87ea7c0fBC3431f20B5B26dd9f7f32571Aa2ba';
const PROVIDER = '0x633E5a7C5e612d9981538F60D824cC03be97e2Ab';
const TRAC = '0xA81a52B4dda010896cDd386C7fBdc5CDc835ba23';
const NOW = Date.parse('2026-08-06T08:00:00Z');

const terms = {
  termsVersion: 'tab-terms/v1', chain: 'base:8453', tracContract: TRAC,
  providerAddress: PROVIDER, refundAddress: BO,
  confirmationDepth: 12, minimumCreditTrac: '1', expiryMs: 30 * 60 * 1000,
  rolloverPolicy: 'none', refundOnExpiry: true, askMicroPer1k: 100,
  scheduleVersion: 'read-schedule/1.0-provisional',
};
const art = D.buildOpeningArtifact(BO, terms, NOW);
const xfer = (over = {}) => ({ txHash: '0xdep', from: BO, to: PROVIDER, token: TRAC,
  amountTrac: '1', blockNumber: 1000, safeHeadBlock: 1011, ...over });

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); console.log('✔', n); pass++; } catch (e) { console.log('✖', n, '—', e.message); fail++; } };

t('term 4: opening artifact locks + echoes the refund address', () => {
  assert.equal(art.refundAddressEcho, BO);
  assert.equal(art.terms.refundAddress, BO);
  assert.ok(art.termsDigest.startsWith('sha256:'));
});
t('term 5: terms digest changes if ANY term changes (countersig covers terms)', () => {
  const d1 = D.termsDigest(terms);
  const d2 = D.termsDigest({ ...terms, confirmationDepth: 1 });
  const d3 = D.termsDigest({ ...terms, refundAddress: PROVIDER });
  assert.notEqual(d1, d2); assert.notEqual(d1, d3);
});
t('term 3: rollover is structurally impossible', () => {
  assert.throws(() => D.buildOpeningArtifact(BO, { ...terms, rolloverPolicy: 'auto' }, NOW), /ROLLOVER/);
});
t('term 1: 11 confirmations is NOT enough (safe head, not receipt)', () => {
  const v = D.evaluateDeposit(xfer({ safeHeadBlock: 1010 }), art, NOW);
  assert.equal(v.ok, false); assert.equal(v.code, 'E_DEPOSIT_UNCONFIRMED');
  assert.match(v.detail, /11\/12/);
});
t('term 1: 12 confirmations at safe head credits', () => {
  const v = D.evaluateDeposit(xfer(), art, NOW);
  assert.equal(v.ok, true); assert.equal(v.creditMicroTrac, 1_000_000);
});
t('term 2: below the 1 TRAC minimum is refused', () => {
  const v = D.evaluateDeposit(xfer({ amountTrac: '0.5' }), art, NOW);
  assert.equal(v.code, 'E_DEPOSIT_BELOW_MINIMUM');
});
t('wrong token (a lookalike ERC-20) is refused', () => {
  assert.equal(D.evaluateDeposit(xfer({ token: '0xdeadbeef' }), art, NOW).code, 'E_DEPOSIT_WRONG_TOKEN');
});
t('wrong recipient is refused', () => {
  assert.equal(D.evaluateDeposit(xfer({ to: '0xattacker' }), art, NOW).code, 'E_DEPOSIT_WRONG_RECIPIENT');
});
t('a stranger cannot fund someone else’s tab (refund-address binding attack)', () => {
  assert.equal(D.evaluateDeposit(xfer({ from: '0xstranger' }), art, NOW).code, 'E_DEPOSIT_WRONG_SENDER');
});
t('term 3: deposits after expiry are refused', () => {
  const late = NOW + 31 * 60 * 1000;
  assert.equal(D.evaluateDeposit(xfer(), art, late).code, 'E_TAB_EXPIRED');
});
t('credit records the full evidence chain incl. locked refund address', () => {
  const v = D.evaluateDeposit(xfer(), art, NOW);
  const b = D.creditDeposit(home, xfer(), art, v);
  assert.equal(b.balance, 1_000_000);
  const j = readFileSync(join(home, 'metering', 'read-journal.jsonl'), 'utf8');
  assert.ok(j.includes('"kind":"trac-deposit"'));
  assert.ok(j.includes(BO));
  assert.ok(j.includes('"confirmations":12'));
  assert.ok(j.includes('termsDigest'));
});
t('term 3: expiry refunds the unspent balance to the LOCKED address', () => {
  const out = D.evaluateExpiry(home, art, 1_000_000, NOW + 31 * 60 * 1000);
  assert.equal(out.expired, true);
  assert.equal(out.refundAddress, BO);
  assert.equal(out.refundMicroTrac, 1_000_000);
  assert.equal(out.rollover, 'none');
});
t('earned-but-unsettled stays payable to the provider on expiry', () => {
  L.recordReadLeg(home, { principal: BO, units: 100, breakdown: {}, scopeQuads: 26200,
    sparql: 'SELECT ?s WHERE { ?s ?p ?o }', responseBody: '{}', askMicroPer1k: 100 });
  const out = D.evaluateExpiry(home, art, 1_000_000, NOW + 31 * 60 * 1000);
  assert.equal(out.earnedMicroTrac, 10);          // 100 U * 100 / 1000
  assert.equal(out.refundMicroTrac, 1_000_000 - 10);
});
console.log(`\n${pass}/${pass + fail} deposit-rail gates pass`);
process.exit(fail ? 1 : 0);
