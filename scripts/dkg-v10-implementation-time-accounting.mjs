#!/usr/bin/env node
// Emits N-Quads for the D26 implementation session — the code turn that
// landed the C.2 time-accurate accounting design from
// <decision:2026-04-23/time-based-accounting> into the V10 contracts,
// storages, and tests.
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
function int(n)  { return `"${n}"^^<${NS.xsd}integer>`; }
function dt(iso) { return `"${iso}"^^<${NS.xsd}dateTime>`; }

const quads = [];
function q(s, p, o) { quads.push(`${s} ${p} ${o} ${GRAPH} .`); }

// ── IRIs ────────────────────────────────────────────────────────────────────
const SESSION_IMPL = '<session:2026-04-23/v10-d26-implementation>';
const D_TIMEACCT   = '<decision:2026-04-23/time-based-accounting>';

const F_CSS_SOL   = '<file:packages/evm-module/contracts/storage/ConvictionStakingStorage.sol>';
const F_RSS_SOL   = '<file:packages/evm-module/contracts/storage/RandomSamplingStorage.sol>';
const F_RS_SOL    = '<file:packages/evm-module/contracts/RandomSampling.sol>';
const F_V10_SOL   = '<file:packages/evm-module/contracts/StakingV10.sol>';
const F_CSS_TEST  = '<file:packages/evm-module/test/unit/ConvictionStakingStorage.test.ts>';
const F_RSS_TEST  = '<file:packages/evm-module/test/unit/RandomSamplingStorage.test.ts>';
const F_NFT_TEST  = '<file:packages/evm-module/test/unit/DKGStakingConvictionNFT.test.ts>';
const F_V10_TEST  = '<file:packages/evm-module/test/v10-conviction.test.ts>';
const F_D26_TEST  = '<file:packages/evm-module/test/integration/D26TimeAccurateStaking.test.ts>';

// ── Implementation Session ──────────────────────────────────────────────────
q(SESSION_IMPL, a,                    dg('Session'));
q(SESSION_IMPL, dg('agent'),          str('cursor-agent/claude-opus-4.7'));
q(SESSION_IMPL, dg('startedAt'),      dt('2026-04-23T12:00:00Z'));
q(SESSION_IMPL, dg('endedAt'),        dt('2026-04-23T23:30:00Z'));
q(SESSION_IMPL, dg('filesModified'),  int(9));
q(SESSION_IMPL, dg('implementsDecision'), D_TIMEACCT);
q(SESSION_IMPL, dg('summary'), str(
  "Implemented the D26 C.2 time-accurate staking accounting design. " +
  "ConvictionStakingStorage: renamed Position.expiryEpoch -> expiryTimestamp, " +
  "dropped BLOCK_DRIFT_BUFFER and the epoch-diff accumulator, added " +
  "runningNodeEffectiveStake / nodeLastSettledAt / a sorted per-node expiry " +
  "queue (nodeExpiryTimes + nodeExpiryDrop + nodeExpiryHead). All mutators " +
  "(createPosition / updateOnRelock / updateOnRedelegate / " +
  "createNewPositionFromExisting / deletePosition / decreaseRaw / increaseRaw) " +
  "maintain the running state and expiry queue; settleNodeTo drains " +
  "expiries lazily (event-density-bounded, no dormancy bomb). Version " +
  "bumped to 3.0.0. " +
  "RandomSamplingStorage: replaced the per-(node, epoch) scorePerStake scalar " +
  "with EpochIndex { firstScorePerStake36, lastScorePerStake36, " +
  "Checkpoint[] mid }; appendCheckpoint / setLastScorePerStake mutators and " +
  "findScorePerStakeAt binary-search view added; legacy " +
  "getNodeEpochScorePerStake preserved as an adapter for V8 call sites " +
  "(Staking.sol, StakingKPI.sol). Version bumped to 2.0.0. " +
  "RandomSampling.submitProof now calls CSS.settleNodeTo(id, now), reads the " +
  "post-drain running effective stake for the denominator, and appends one " +
  "checkpoint at block.timestamp. " +
  "StakingV10._claim and _prepareForStakeChangeV10: per-epoch branching on " +
  "expiryTimestamp; two O(1) sentinel reads for fully-boosted / fully-expired " +
  "epochs, and exactly one findScorePerStakeAt binary search in the single " +
  "epoch containing expiryTimestamp. Dead epochs skip in O(1). " +
  "Tests: rewrote ConvictionStakingStorage.test.ts from scratch for the " +
  "timestamp model (expiryTimestamp, running state, sorted queue, settleNodeTo). " +
  "Updated DKGStakingConvictionNFT.test.ts, RandomSamplingStorage.test.ts, " +
  "v10-conviction.test.ts for the new shapes. Added " +
  "test/integration/D26TimeAccurateStaking.test.ts with new coverage for " +
  "mid-epoch expiry denominator, claim binary-search path, and node dormancy " +
  "resume. Full @unit + @integration suites green."
));
for (const f of [
  F_CSS_SOL, F_RSS_SOL, F_RS_SOL, F_V10_SOL,
  F_CSS_TEST, F_RSS_TEST, F_NFT_TEST, F_V10_TEST, F_D26_TEST,
]) {
  q(SESSION_IMPL, dg('modifiedFile'), f);
}

process.stdout.write(quads.join('\n') + '\n');
