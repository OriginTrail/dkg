// Stage-3 endpoint gates: the buyer's journey, end to end, without money.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as edSign, createPrivateKey } from 'node:crypto';
import assert from 'node:assert/strict';
const S = await import('/tmp/meterbuild/stage3-endpoint.js');
const C = await import('/tmp/meterbuild/capability.js');
const L = await import('/tmp/meterbuild/ledger.js');
const D = await import('/tmp/meterbuild/deposit-rail.js');

const home = mkdtempSync(join(tmpdir(), 's3-'));
L.setDebitGate((h, p, now) => D.debitAllowed(h, p, now));
const BO = '0x8A87ea7c0fBC3431f20B5B26dd9f7f32571Aa2ba';
const PROVIDER = '0x633E5a7C5e612d9981538F60D824cC03be97e2Ab';
const TRAC = '0xA81a52B4dda010896cDd386C7fBdc5CDc835ba23';
const wallet = generateKeyPairSync('ed25519'), session = generateKeyPairSync('ed25519');
const pem = (k,t)=>k.export({type:t==='pub'?'spki':'pkcs8',format:'pem'}).toString();
const SCHED = 'sha256:sched', PRICE = 'sha256:price';

function delegation(over={}) {
  const d = { domain:'odysseus-dkg:delegation:v1', capabilityId:'cap-stage3-001', tabPrincipal:BO,
    sessionPublicKeyPem: pem(session.publicKey,'pub'), agentUrn:'urn:odysseus-dkg:agent:hermes-bo',
    audience:{settlement:'settle-main',nodeClasses:['dkg-edge-mainnet']},
    routes:['POST /api/query','POST /v1/metered'], bindings:{scheduleDigest:SCHED,priceVectorDigest:PRICE},
    caps:{absoluteMicroTrac:1000000,windowMicroTrac:100000,windowMs:60000},
    notBefore:new Date(Date.now()-3600e3).toISOString(), expiresAt:new Date(Date.now()+3600e3).toISOString(),
    tier:'session-key', ...over };
  return { ...d, walletSignature: edSign(null, C.delegationPreimage(d), createPrivateKey(pem(wallet.privateKey,'priv'))).toString('base64') };
}
const req = { route:'POST /api/query', nodeClass:'dkg-edge-mainnet', settlementId:'settle-main', scheduleDigest:SCHED, priceVectorDigest:PRICE };
const fresh = { observedAt: Date.now()-1000, maxCheckpointAgeMs: 60000 };

let pass=0, fail=0;
const t=(n,fn)=>{try{fn();console.log('✔',n);pass++;}catch(e){console.log('✖',n,'—',e.message);fail++;}};

t('quote: buyer can price and verify BEFORE committing anything', () => {
  const q = S.termsQuote({ providerAddress: PROVIDER, askMicroPer1k: 100, scheduleVersion: 'read-schedule/1.0-provisional',
    coefficientsDigest: SCHED, meterMode: 'shadow', safeHeadBlock: 49600000 });
  assert.equal(q.terms.confirmationDepth, 12);
  assert.equal(q.terms.minimumCreditTrac, '1');
  assert.equal(q.terms.rolloverPolicy, 'none');
  assert.equal(q.terms.tracContract, TRAC);
  assert.equal(q.billing, 'none (metering only)', 'shadow must never advertise billing');
  assert.ok(q.termsDigest.startsWith('sha256:'));
});

t('quote in enforce mode advertises enforcement honestly', () => {
  const q = S.termsQuote({ providerAddress: PROVIDER, askMicroPer1k: 100, scheduleVersion: 'v', coefficientsDigest: SCHED, meterMode: 'enforce', safeHeadBlock: 1 });
  assert.match(q.billing, /enforcement active/);
});

t('handshake: zero-value preflight passes and touches NO ledger', () => {
  const r = S.handshake(home, { delegation: delegation(), walletPublicKeyPem: pem(wallet.publicKey,'pub'), request: req, revocationCheckpoint: fresh });
  assert.equal(r.ok, true); assert.equal(r.verdict, 'OK');
  assert.equal(r.estimatedMicroTrac, 0); assert.equal(r.ledgerTouched, false);
  assert.equal(L.balance(home, BO).balance, 0);
});

t('handshake: stale revocation fails closed, still no ledger touch', () => {
  const r = S.handshake(home, { delegation: delegation(), walletPublicKeyPem: pem(wallet.publicKey,'pub'), request: req,
    revocationCheckpoint: { observedAt: null, maxCheckpointAgeMs: 60000 } });
  assert.equal(r.ok, false); assert.equal(r.verdict, 'E_CAP_STALE_REVOCATION_STATE');
  assert.equal(L.balance(home, BO).balance, 0);
});

t('handshake: price-digest substitution rejected (colluding-node repricing)', () => {
  const r = S.handshake(home, { delegation: delegation(), walletPublicKeyPem: pem(wallet.publicKey,'pub'),
    request: { ...req, priceVectorDigest: 'sha256:inflated' }, revocationCheckpoint: fresh });
  assert.equal(r.verdict, 'E_CAP_PRICE_MISMATCH');
});

let opened;
t('tab open: requires a valid delegation, echoes the LOCKED refund address', () => {
  opened = S.openTab(home, { delegation: delegation(), walletPublicKeyPem: pem(wallet.publicKey,'pub'), refundAddress: BO,
    providerAddress: PROVIDER, askMicroPer1k: 100, scheduleVersion: 'read-schedule/1.0-provisional', request: req, revocationCheckpoint: fresh });
  assert.equal(opened.opened, true);
  assert.equal(opened.artifact.refundAddressEcho, BO);
  assert.equal(opened.depositTo, PROVIDER);
  assert.ok(opened.countersignDigest.startsWith('sha256:'));
});

t('tab open: forged delegation cannot open a tab', () => {
  const other = generateKeyPairSync('ed25519');
  const r = S.openTab(home, { delegation: delegation(), walletPublicKeyPem: pem(other.publicKey,'pub'), refundAddress: BO,
    providerAddress: PROVIDER, askMicroPer1k: 100, scheduleVersion: 'v', request: req, revocationCheckpoint: fresh });
  assert.equal(r.opened, false); assert.equal(r.code, 'E_CAP_BAD_SIGNATURE');
});

const xfer = (over={}) => ({ txHash:'0xreal', from:BO, to:PROVIDER, token:TRAC, amountTrac:'1', blockNumber:49600000, safeHeadBlock:49600011, ...over });

t('deposit: 11 confirmations refused (safe head, buyer-set)', () => {
  const r = S.creditObservedDeposit(home, BO, xfer({ safeHeadBlock: 49600010 }));
  assert.equal(r.credited, false); assert.equal(r.code, 'E_DEPOSIT_UNCONFIRMED');
});

t('deposit: 12 confirmations credits, balance visible to the buyer', () => {
  const r = S.creditObservedDeposit(home, BO, xfer());
  assert.equal(r.credited, true); assert.equal(r.confirmations, 12);
  const v = S.tabView(home, BO, 49600011);
  assert.equal(v.balanceMicroTrac, 1_000_000);
  assert.equal(v.refundAddress, BO);
  assert.equal(v.tabOpen, true); assert.equal(v.expired, false);
});

t('deposit: a stranger cannot fund this tab', () => {
  const r = S.creditObservedDeposit(home, BO, xfer({ from: '0xstranger', txHash: '0xevil' }));
  assert.equal(r.code, 'E_DEPOSIT_WRONG_SENDER');
});

t('deposit into a principal with no open tab is refused', () => {
  const r = S.creditObservedDeposit(home, '0xnotab', xfer({ from: '0xnotab' }));
  assert.equal(r.code, 'E_NO_OPEN_TAB');
});

t('billing still requires a leg countersignature — endpoint grants no spending right', () => {
  const leg = L.recordReadLeg(home, { principal: BO, units: 3.9, breakdown: {}, scopeQuads: 26200,
    sparql: 'SELECT ?s WHERE { ?s ?p ?o }', responseBody: '{}', askMicroPer1k: 100 });
  assert.equal(leg.settlement.status, 'pending-countersignature');
  const adm = C.admissibleForSettlement({ leg, sessionPublicKeyPem: pem(session.publicKey,'pub'), now: Date.now() });
  assert.equal(adm.ok, false, 'an uncountersigned leg must not settle even with a funded tab');
});

console.log(`\n${pass}/${pass+fail} Stage-3 endpoint gates pass`);
process.exit(fail?1:0);
