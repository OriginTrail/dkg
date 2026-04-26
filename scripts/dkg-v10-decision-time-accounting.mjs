#!/usr/bin/env node
// Emits N-Quads for Decision 4 (C.2 time-based accounting) + adds a followup
// Decision pointer on the V10 session.
//
// Pipe into:
//   dkg shared-memory write <graph> --file - --format nquads

const GRAPH =
  '<did:dkg:context-graph:0x1Fe3D11Cf77b71528A66BDCEF97BdaB79327ee62/dkg-v10-smart-contracts>';

const NS = {
  dg:  'https://ontology.dkg.io/devgraph#',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
};

function iri(u) { return `<${u}>`; }
function dg(p)  { return iri(NS.dg + p); }
const a         = iri(NS.rdf + 'type');

function str(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()}"`;
}
function dt(iso) { return `"${iso}"^^<${NS.xsd}dateTime>`; }

const quads = [];
function q(s, p, o) { quads.push(`${s} ${p} ${o} ${GRAPH} .`); }

// ── IRIs ────────────────────────────────────────────────────────────────────
const SESSION    = '<session:2026-04-23/v10-staking-redesign>';
const D_TIMEACCT = '<decision:2026-04-23/time-based-accounting>';

const C_STORAGE    = '<symbol:packages/evm-module/contracts/storage/ConvictionStakingStorage.sol/contract/ConvictionStakingStorage>';
const C_STAKING    = '<symbol:packages/evm-module/contracts/StakingV10.sol/contract/StakingV10>';
const C_RSAMPLING  = '<symbol:packages/evm-module/contracts/RandomSampling.sol/contract/RandomSampling>';
const C_RSSTORAGE  = '<symbol:packages/evm-module/contracts/storage/RandomSamplingStorage.sol/contract/RandomSamplingStorage>';

// ── Decision 4: time-based accounting (C.2) ─────────────────────────────────
q(D_TIMEACCT, a,             dg('Decision'));
q(D_TIMEACCT, dg('summary'), str(
  "Replace epoch-quantized scorePerStake with timestamp-accurate accounting: " +
  "per-(node, epoch) EpochIndex { firstScorePerStake36, lastScorePerStake36, " +
  "Checkpoint[] mid } plus running node effective stake with bucketed expiries. " +
  "Reward pools remain epoch-scoped."
));
q(D_TIMEACCT, dg('rationale'), str(
  "Today staking positions are defined in real time (30/90/180/366 day locks) " +
  "but scoring is settled at epoch boundaries. Two lies result: (a) the node's " +
  "effective-stake denominator in submitProof is stale between boundary " +
  "updates, and (b) a delegator's boost is applied uniformly across an epoch " +
  "even when their lock expires mid-epoch, creating small but real " +
  "over/under-payment. With proofs landing every ~30 minutes, sub-epoch " +
  "precision is a product requirement. " +
  "Chosen path (Option C.2): keep reward pools epoch-scoped (preserves " +
  "existing pool distribution semantics) but make the per-node score index " +
  "timestamped. For each (node, epoch) store firstScorePerStake36 and " +
  "lastScorePerStake36 sentinels plus an append-only Checkpoint[] mid[] of " +
  "(timestamp, scorePerStake36) populated by submitProof. Also maintain " +
  "runningNodeEffectiveStake[id], nodeLastSettledAt[id], and " +
  "nodeExpiryBucket[id][bucket] so submitProof can integrate " +
  "score / effectiveStake over (lastSettledAt, now) and apply queued expiries. " +
  "Rejected C.1 (continuous stream index) because it couples pool math across " +
  "epoch boundaries; kept epoch granularity for pools only. " +
  "Claim cost: outer loop stays per-epoch (pool math unchanged). Within an " +
  "epoch, 2 O(1) sentinel reads suffice when boost is fully active or fully " +
  "expired in that epoch. Exactly one epoch per claim (the one containing " +
  "expiryTimestamp) requires a single binary search into mid[] — no iteration " +
  "over proofs. Dead epochs (firstScorePerStake36 == lastScorePerStake36) are " +
  "skipped in O(1)."
));
q(D_TIMEACCT, dg('madeBy'),  str('aleatoric@origintrail + cursor-agent'));
q(D_TIMEACCT, dg('madeAt'),  dt('2026-04-23T00:00:00Z'));
q(D_TIMEACCT, dg('affects'), C_STORAGE);
q(D_TIMEACCT, dg('affects'), C_STAKING);
q(D_TIMEACCT, dg('affects'), C_RSAMPLING);
q(D_TIMEACCT, dg('affects'), C_RSSTORAGE);

// Backlink the decision onto the session.
q(SESSION, dg('decided'), D_TIMEACCT);

process.stdout.write(quads.join('\n') + '\n');
