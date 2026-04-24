#!/usr/bin/env node
// Emits N-Quads for the V10 staking redesign session + decisions, scoped to
// the dkg-v10-smart-contracts context graph. Writes to stdout; pipe into
//   dkg shared-memory write <graph> --file - --format nquads
// (or to a file).
//
// Hand-written rather than converted from Turtle so we control every byte
// the daemon sees — the in-memory re-parser is stricter than the Turtle
// front-end and rejected multi-line triple-quoted strings.

const GRAPH =
  '<did:dkg:context-graph:0x1Fe3D11Cf77b71528A66BDCEF97BdaB79327ee62/dkg-v10-smart-contracts>';

const NS = {
  dg:   'https://ontology.dkg.io/devgraph#',
  rdf:  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  xsd:  'http://www.w3.org/2001/XMLSchema#',
};

function iri(u)    { return `<${u}>`; }
function dg(p)     { return iri(NS.dg + p); }
const a            = iri(NS.rdf + 'type');

function str(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()}"`;
}
function int(n)    { return `"${n}"^^<${NS.xsd}integer>`; }
function dt(iso)   { return `"${iso}"^^<${NS.xsd}dateTime>`; }

const quads = [];
function q(s, p, o) { quads.push(`${s} ${p} ${o} ${GRAPH} .`); }

// ── IRIs ────────────────────────────────────────────────────────────────────
const SESSION   = '<session:2026-04-23/v10-staking-redesign>';
const D_TIER0   = '<decision:2026-04-23/tier-0-nft-mint>';
const D_REDEL   = '<decision:2026-04-23/redelegate-in-place>';
const D_WITHDR  = '<decision:2026-04-23/atomic-withdraw>';

const F_NFT     = '<file:packages/evm-module/contracts/DKGStakingConvictionNFT.sol>';
const F_STAKING = '<file:packages/evm-module/contracts/StakingV10.sol>';
const F_STORAGE = '<file:packages/evm-module/contracts/storage/ConvictionStakingStorage.sol>';
const F_T_NFT   = '<file:packages/evm-module/test/unit/DKGStakingConvictionNFT.test.ts>';
const F_T_STOR  = '<file:packages/evm-module/test/unit/ConvictionStakingStorage.test.ts>';
const F_T_V10   = '<file:packages/evm-module/test/v10-conviction.test.ts>';

const C_STAKING = '<symbol:packages/evm-module/contracts/StakingV10.sol/contract/StakingV10>';
const C_NFT     = '<symbol:packages/evm-module/contracts/DKGStakingConvictionNFT.sol/contract/DKGStakingConvictionNFT>';
const C_STORAGE = '<symbol:packages/evm-module/contracts/storage/ConvictionStakingStorage.sol/contract/ConvictionStakingStorage>';

// ── Session ─────────────────────────────────────────────────────────────────
q(SESSION, a,                    dg('Session'));
q(SESSION, dg('agent'),          str('cursor-agent/claude-opus-4.7'));
q(SESSION, dg('startedAt'),      dt('2026-04-23T00:00:00Z'));
q(SESSION, dg('endedAt'),        dt('2026-04-23T23:59:59Z'));
q(SESSION, dg('filesModified'),  int(6));
q(SESSION, dg('summary'), str(
  "V10 staking redesign. Three architectural decisions: (1) tier 0 mints are " +
  "first-class 1x NFTs; (2) redelegate updates node in place and preserves " +
  "the original lock expiry; (3) withdraw is a single atomic tx that burns " +
  "the NFT and transfers TRAC (prior 15-day delay and PendingWithdrawal " +
  "storage were removed). Also wired a Solidity AST indexer into the DKG " +
  "CLI so future agents can query this project's code graph."
));
for (const f of [F_NFT, F_STAKING, F_STORAGE, F_T_NFT, F_T_STOR, F_T_V10]) {
  q(SESSION, dg('modifiedFile'), f);
}

// ── Decision 1: tier 0 NFTs ─────────────────────────────────────────────────
q(D_TIER0, a,              dg('Decision'));
q(D_TIER0, dg('summary'),  str(
  "Allow lockTier == 0 (no lock, 1x multiplier) as a first-class NFT mint."
));
q(D_TIER0, dg('rationale'), str(
  "A no-lock position is a supported V10 product. Rejecting tier 0 in " +
  "StakingV10.stake would force a parallel raw-position path alongside the " +
  "NFT path (complexity with no upside). Making every position an NFT " +
  "(including 1x) yields uniform ERC-721 ownership, a single withdraw / " +
  "redelegate surface, and a simpler UI (one product, five tier choices: " +
  "0 / 1 / 3 / 6 / 12). Tier multipliers: 0=1.0x, 1=1.5x (30d), 3=2.0x (90d), " +
  "6=3.5x (180d), 12=6.0x (366d)."
));
q(D_TIER0, dg('madeBy'),    str('aleatoric@origintrail + cursor-agent'));
q(D_TIER0, dg('madeAt'),    dt('2026-04-23T00:00:00Z'));
q(D_TIER0, dg('affects'),   C_STAKING);
q(D_TIER0, dg('affects'),   C_NFT);

// ── Decision 2: redelegate in place ─────────────────────────────────────────
q(D_REDEL, a,              dg('Decision'));
q(D_REDEL, dg('summary'),  str(
  "redelegate updates the NFT's node in place; it does NOT burn and remint."
));
q(D_REDEL, dg('rationale'), str(
  "The original design burned the position NFT on redelegate and minted a " +
  "fresh one against the new node, which reset the user's remaining lock " +
  "to a new tier's full duration. Hostile to stakers mid-lock (e.g. day 29 " +
  "of a 30-day tier) and buys nothing structurally: tier and multiplier are " +
  "properties of the position, not the node. New behaviour: redelegate " +
  "mutates storage to swap nodeId, preserving tokenId and lockExpiry; " +
  "emits PositionRedelegated(tokenId, oldNode, newNode)."
));
q(D_REDEL, dg('madeBy'),    str('aleatoric@origintrail + cursor-agent'));
q(D_REDEL, dg('madeAt'),    dt('2026-04-23T00:00:00Z'));
q(D_REDEL, dg('affects'),   C_NFT);
q(D_REDEL, dg('affects'),   C_STORAGE);

// ── Decision 3: atomic withdraw ─────────────────────────────────────────────
q(D_WITHDR, a,              dg('Decision'));
q(D_WITHDR, dg('summary'),  str(
  "withdraw is a single tx that burns the NFT and transfers TRAC; no delay, " +
  "no PendingWithdrawal."
));
q(D_WITHDR, dg('rationale'), str(
  "Prior spec implied a 15-day delay with a two-step requestWithdraw / " +
  "finalizeWithdraw flow and a PendingWithdrawal storage slot; that was " +
  "older protocol design and WITHDRAWAL_DELAY had already been set to 0. " +
  "Unified design: after lockExpiry the holder calls withdraw(tokenId); the " +
  "contract burns the NFT, transfers TRAC, emits PositionWithdrawn. No " +
  "partial withdrawals (stake again for a smaller position). withdraw() " +
  "now returns uint96 amount so the NFT layer can emit the authoritative " +
  "transfer amount."
));
q(D_WITHDR, dg('madeBy'),    str('aleatoric@origintrail + cursor-agent'));
q(D_WITHDR, dg('madeAt'),    dt('2026-04-23T00:00:00Z'));
q(D_WITHDR, dg('affects'),   C_STAKING);
q(D_WITHDR, dg('affects'),   C_NFT);
q(D_WITHDR, dg('affects'),   C_STORAGE);

process.stdout.write(quads.join('\n') + '\n');
