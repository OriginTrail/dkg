// B2a gate: the D14 red-team suite. Every case models something Blackbox,
// Hermes or OpenClaw named as an attack in round 1.
import { generateKeyPairSync, sign as edSign, createPrivateKey, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const C = await import('/tmp/meterbuild/capability.js');
const { canonicalize } = await import('/tmp/meterbuild/ledger.js');

const wallet = generateKeyPairSync('ed25519');
const session = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const pem = (k, t) => k.export({ type: t === 'pub' ? 'spki' : 'pkcs8', format: 'pem' }).toString();
const walletPub = pem(wallet.publicKey, 'pub'), sessionPub = pem(session.publicKey, 'pub');
const NOW = Date.parse('2026-08-06T00:00:00Z');

function makeDelegation(over = {}) {
  const d = {
    domain: 'odysseus-dkg:delegation:v1',
    capabilityId: 'cap-001', tabPrincipal: '0xBo', sessionPublicKeyPem: sessionPub,
    agentUrn: 'urn:odysseus-dkg:agent:hermes-bo',
    audience: { settlement: 'settle-main', nodeClasses: ['dkg-edge-mainnet'] },
    routes: ['POST /api/query', 'POST /v1/metered'],
    bindings: { scheduleDigest: 'sha256:sched', priceVectorDigest: 'sha256:price' },
    caps: { absoluteMicroTrac: 10000, windowMicroTrac: 1000, windowMs: 60000 },
    notBefore: '2026-08-05T00:00:00Z', expiresAt: '2026-08-07T00:00:00Z',
    tier: 'session-key', ...over,
  };
  const sig = edSign(null, C.delegationPreimage(d), createPrivateKey(pem(wallet.privateKey, 'priv'))).toString('base64');
  return { ...d, walletSignature: sig };
}
const baseState = { spentMicroTrac: 0, window: { since: NOW, spentMicroTrac: 0 }, sequence: 0, revoked: false };
const baseReq = { route: 'POST /api/query', nodeClass: 'dkg-edge-mainnet', settlementId: 'settle-main',
  scheduleDigest: 'sha256:sched', priceVectorDigest: 'sha256:price', sequence: 1, estimatedMicroTrac: 100 };
const fresh = { observedAt: NOW - 1000, maxCheckpointAgeMs: 60000 };
const V = (over = {}) => C.verifyCapability({
  delegation: over.delegation ?? makeDelegation(), walletPublicKeyPem: over.walletPublicKeyPem ?? walletPub,
  state: { ...baseState, ...(over.state ?? {}) }, now: over.now ?? NOW,
  request: { ...baseReq, ...(over.request ?? {}) }, revocationCheckpoint: over.revocationCheckpoint ?? fresh,
});

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); console.log('✔', n); pass++; } catch (e) { console.log('✖', n, '—', e.message); fail++; } };

t('happy path verifies', () => assert.equal(V().code, 'OK'));
t('Blackbox: stale revocation state FAILS CLOSED', () =>
  assert.equal(V({ revocationCheckpoint: { observedAt: NOW - 999999, maxCheckpointAgeMs: 60000 } }).code, 'E_CAP_STALE_REVOCATION_STATE'));
t('Blackbox: unknown revocation state fails closed', () =>
  assert.equal(V({ revocationCheckpoint: { observedAt: null, maxCheckpointAgeMs: 60000 } }).code, 'E_CAP_STALE_REVOCATION_STATE'));
t('revoked capability rejected', () => assert.equal(V({ state: { revoked: true } }).code, 'E_CAP_REVOKED'));
t('forged delegation (wrong wallet) rejected', () => assert.equal(V({ walletPublicKeyPem: pem(other.publicKey,'pub') }).code, 'E_CAP_BAD_SIGNATURE'));
t('tampered caps invalidate the signature', () => {
  const d = makeDelegation(); d.caps.absoluteMicroTrac = 999999999;
  assert.equal(V({ delegation: d }).code, 'E_CAP_BAD_SIGNATURE');
});
t('expired capability rejected (checkpoint kept fresh so expiry is the reason)', () => {
  const later = Date.parse('2026-08-08T00:00:00Z');
  assert.equal(V({ now: later, revocationCheckpoint: { observedAt: later - 1000, maxCheckpointAgeMs: 60000 } }).code, 'E_CAP_EXPIRED');
});
t('fail-closed precedence: stale revocation outranks every other check', () => {
  const later = Date.parse('2026-08-08T00:00:00Z');
  assert.equal(V({ now: later }).code, 'E_CAP_STALE_REVOCATION_STATE');
});
t('OpenClaw: replay at another node (wrong node class) rejected', () =>
  assert.equal(V({ request: { nodeClass: 'someone-elses-node' } }).code, 'E_CAP_WRONG_AUDIENCE'));
t('wrong settlement audience rejected', () => assert.equal(V({ request: { settlementId: 'evil-settle' } }).code, 'E_CAP_WRONG_AUDIENCE'));
t('route confusion rejected', () => assert.equal(V({ request: { route: 'POST /api/admin' } }).code, 'E_CAP_WRONG_ROUTE'));
t('OpenClaw: colluding node cannot REPRICE (price digest binding)', () =>
  assert.equal(V({ request: { priceVectorDigest: 'sha256:inflated' } }).code, 'E_CAP_PRICE_MISMATCH'));
t('schedule swap rejected', () => assert.equal(V({ request: { scheduleDigest: 'sha256:other' } }).code, 'E_CAP_SCHEDULE_MISMATCH'));
t('Blackbox: cross-path concurrent replay killed by one shared sequence', () => {
  assert.equal(V({ state: { sequence: 5 }, request: { sequence: 5 } }).code, 'E_CAP_SEQUENCE_REPLAY');
  assert.equal(V({ state: { sequence: 5 }, request: { sequence: 7 } }).code, 'E_CAP_SEQUENCE_REPLAY');
  assert.equal(V({ state: { sequence: 5 }, request: { sequence: 6 } }).code, 'OK');
});
t('absolute cap bounds worst-case theft', () =>
  assert.equal(V({ state: { spentMicroTrac: 9950 }, request: { estimatedMicroTrac: 100 } }).code, 'E_CAP_ABSOLUTE_CAP'));
t('OpenClaw: velocity cap slows fast drain before revocation propagates', () =>
  assert.equal(V({ state: { window: { since: NOW - 1000, spentMicroTrac: 950 } }, request: { estimatedMicroTrac: 100 } }).code, 'E_CAP_VELOCITY_CAP'));
t('velocity window rolls over', () =>
  assert.equal(V({ state: { window: { since: NOW - 120000, spentMicroTrac: 999999 } } }).code, 'OK'));

// settlement admissibility
const leg = { legType: 'read', pricing: { costMicroTrac: 50 }, meter: { units: 6.5 } };
const digest = 'sha256:' + createHash('sha256').update(canonicalize(leg)).digest('hex');
const countersign = (obj, key) => edSign(null, Buffer.concat([Buffer.from('odysseus-dkg:capability:v1\n'), Buffer.from(obj)]), createPrivateKey(pem(key,'priv'))).toString('base64');

t('D14(a): uncountersigned leg is INADMISSIBLE for settlement', () =>
  assert.equal(C.admissibleForSettlement({ leg, sessionPublicKeyPem: sessionPub, now: NOW }).code, 'E_SETTLE_NO_COUNTERSIGNATURE'));
t('D14(a): correct countersignature admits', () =>
  assert.equal(C.admissibleForSettlement({ leg, sessionPublicKeyPem: sessionPub, countersignature: countersign(digest, session.privateKey), now: NOW }).ok, true));
t('D14(a): colluding node cannot forge the countersignature', () =>
  assert.equal(C.admissibleForSettlement({ leg, sessionPublicKeyPem: sessionPub, countersignature: countersign(digest, other.privateKey), now: NOW }).ok, false));
t('D14(a): countersignature is bound to the EXACT leg', () => {
  const inflated = { ...leg, pricing: { costMicroTrac: 5000 } };
  assert.equal(C.admissibleForSettlement({ leg: inflated, sessionPublicKeyPem: sessionPub, countersignature: countersign(digest, session.privateKey), now: NOW }).ok, false);
});
t('bounded pre-authorization admits within its ceiling only', () => {
  const pre = { maxMicroTrac: 100, expiresAt: '2026-08-07T00:00:00Z' };
  pre.signature = countersign(canonicalize({ maxMicroTrac: pre.maxMicroTrac, expiresAt: pre.expiresAt }), session.privateKey);
  assert.equal(C.admissibleForSettlement({ leg, sessionPublicKeyPem: sessionPub, preAuthorization: pre, now: NOW }).ok, true);
  const over = { ...leg, pricing: { costMicroTrac: 5000 } };
  assert.equal(C.admissibleForSettlement({ leg: over, sessionPublicKeyPem: sessionPub, preAuthorization: pre, now: NOW }).ok, false);
});
t('OpenClaw: zero-value preflight exercises failures without funds', () => {
  const ok = C.zeroValuePreflight({ delegation: makeDelegation(), walletPublicKeyPem: walletPub, state: baseState, now: NOW,
    request: { ...baseReq, estimatedMicroTrac: undefined }, revocationCheckpoint: fresh });
  assert.equal(ok.code, 'OK');
  const stale = C.zeroValuePreflight({ delegation: makeDelegation(), walletPublicKeyPem: walletPub, state: baseState, now: NOW,
    request: { ...baseReq, estimatedMicroTrac: undefined }, revocationCheckpoint: { observedAt: null, maxCheckpointAgeMs: 1000 } });
  assert.equal(stale.code, 'E_CAP_STALE_REVOCATION_STATE');
});
t('worst case is bounded: cap exhaustion, then nothing', () => {
  let st = { ...baseState };
  let spent = 0, calls = 0;
  while (calls < 500) {
    const v = C.verifyCapability({ delegation: makeDelegation(), walletPublicKeyPem: walletPub, state: st, now: NOW + calls,
      request: { ...baseReq, sequence: st.sequence + 1, estimatedMicroTrac: 100 }, revocationCheckpoint: { observedAt: NOW + calls - 10, maxCheckpointAgeMs: 60000 } });
    if (!v.ok) break;
    st = C.chargeCapability(st, NOW + calls, 60000, 100); spent += 100; calls++;
  }
  assert.ok(spent <= 10000, `theft ceiling breached: ${spent}`);
});
console.log(`\n${pass}/${pass + fail} capability gates pass`);
process.exit(fail ? 1 : 0);
