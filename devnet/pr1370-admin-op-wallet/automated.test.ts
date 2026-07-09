/**
 * PR #1370 — Node-admin OPERATIONAL-WALLET add/remove + the
 * `removeOperationalWallet` purpose guard.
 *
 * What the PR ships (verified in source before authoring):
 *
 *   Daemon route  packages/cli/src/daemon/routes/operational-wallets.ts
 *     GET    /api/operational-wallets            — list the node's local op
 *                                                   wallets (+ admin) annotated
 *                                                   with on-chain `registered`
 *                                                   status. Reads ungated.
 *     POST   /api/operational-wallets {address}  — admin-sign
 *                                                   `Profile.addOperationalWallets`
 *                                                   → address gains the ERC-734
 *                                                   OPERATIONAL purpose (2).
 *     DELETE /api/operational-wallets/:address   — admin-sign `Identity.removeKey`,
 *                                                   but ONLY after the adapter's
 *                                                   pre-flight guards pass.
 *     Both writes require a NODE-ADMIN bearer token (agent-scoped tokens 403).
 *
 *   Adapter guards  packages/chain/src/evm-adapter-identity.ts
 *     removeOperationalWallet(addr):
 *       (g1) refuses the node's PRIMARY operational wallet (anchors identity
 *            resolution) → route 409 CannotRemovePrimaryOperationalWallet
 *       (g2) refuses an address that is an on-chain ADMIN key (purpose 1) —
 *            removing it via this path would strip admin control
 *       (g3) refuses an address that is NOT an on-chain OPERATIONAL key
 *            (purpose 2) — operational-key removal must touch op keys only
 *       (g2)/(g3) throw BEFORE any transaction → no on-chain mutation, route 500.
 *
 * ERC-734 purposes (packages/chain/src/evm-adapter-constants.ts):
 *   ADMIN_KEY_PURPOSE = 1, OPERATIONAL_KEY_PURPOSE = 2.
 *   key hash = keccak256(solidityPacked(['address'], [checksum])).
 *   On-chain truth = IdentityStorage.keyHasPurpose(identityId, keyHash, purpose).
 *
 * ISOLATION (this suite runs against ONE shared 6-node devnet):
 *   - The two GUARD-REJECTION cases (g2 admin key, g3 never-added address, g1
 *     primary) are PRE-FLIGHT READS that throw before sending any tx — they
 *     mutate nothing, so they run safely against a real node (node1).
 *   - The positive add→remove case DOES mutate the node identity, so it adds a
 *     fresh THROWAWAY random address and removes that SAME address (net-zero),
 *     wrapped in try/finally so the throwaway is always de-authorized even if an
 *     assertion fails. It NEVER touches a pre-existing real op wallet / the admin
 *     key, never transfers the identity, and leaves node1 exactly as found.
 *   - No time-warp.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import {
  detectDevnet,
  ensureAllIdentities,
  contractAt,
  getJson,
  postJson,
  httpDelete,
  waitFor,
  type DevnetState,
  type DevnetNode,
} from '../_bootstrap/harness.js';

// ERC-734 key purposes (mirror evm-adapter-constants.ts).
const ADMIN_KEY_PURPOSE = 1n;
const OPERATIONAL_KEY_PURPOSE = 2n;

// IdentityStorage read surface (confirmed in abi/IdentityStorage.json):
//   keyHasPurpose(uint72 identityId, bytes32 _key, uint256 _purpose) -> bool
const IDENTITY_STORAGE_ABI = [
  'function keyHasPurpose(uint72 identityId, bytes32 key, uint256 purpose) view returns (bool)',
  'function getIdentityId(address operational) view returns (uint72)',
];

/** ERC-734 key hash for an address (mirrors adapter `walletKeyHash`). */
function walletKeyHash(address: string): string {
  return ethers.keccak256(ethers.solidityPacked(['address'], [ethers.getAddress(address)]));
}

let state: DevnetState;
let node: DevnetNode;
let identityStorage: ethers.Contract;

/** On-chain purpose check, the same truth the adapter guard reads. */
async function hasPurpose(identityId: bigint, address: string, purpose: bigint): Promise<boolean> {
  return identityStorage.keyHasPurpose(identityId, walletKeyHash(address), purpose) as Promise<boolean>;
}

beforeAll(async () => {
  const detected = await detectDevnet(6);
  if (!detected) {
    throw new Error(
      'No devnet detected — run `./scripts/devnet.sh start 6` before this suite ' +
        '(needs a live 6-node devnet + deployed contracts).',
    );
  }
  state = detected;
  await ensureAllIdentities(state, 4);

  // Use node1 — a core node guaranteed to have an on-chain identity + a
  // configured admin key (devnet.sh createProfile uses the Hardhat key as admin).
  node = state.nodes[1]!;
  if (node.identityId === 0n) {
    throw new Error('node1 has no on-chain identity — bootstrap the devnet first');
  }
  identityStorage = contractAt(state, 'IdentityStorage', IDENTITY_STORAGE_ABI);

  // Sanity: the route's GET surface must report the node is manageable
  // (admin key configured + profile exists) so the positive flow is meaningful.
  const { status, json } = await getJson(node, '/api/operational-wallets');
  expect(status, `GET /api/operational-wallets status\n${JSON.stringify(json)}`).toBe(200);
  expect(json.hasProfile, 'node1 must have an on-chain profile').toBe(true);
  expect(json.canManage, 'node1 must be manageable (admin key + profile)').toBe(true);
}, 240_000);

describe('PR #1370 — node-admin operational wallet add / remove + guard', () => {
  it('GET reflects the node identity + the primary op wallet as on-chain registered', async () => {
    const { status, json } = await getJson(node, '/api/operational-wallets');
    expect(status).toBe(200);
    expect(BigInt(json.identityId)).toBe(node.identityId);
    expect(Array.isArray(json.wallets)).toBe(true);

    // The primary operational wallet (signer / wallets[0]) MUST be on-chain
    // registered as an OPERATIONAL key — both via the route's annotation and
    // directly on-chain (the two views must agree).
    const primary = json.wallets.find((w: any) => w.isPrimary);
    expect(primary, 'GET must surface the primary op wallet').toBeTruthy();
    expect(primary.registered, 'primary op wallet must be on-chain registered').toBe(true);
    expect(
      await hasPurpose(node.identityId, primary.address, OPERATIONAL_KEY_PURPOSE),
      'primary op wallet must have OPERATIONAL purpose on-chain',
    ).toBe(true);

    // The admin wallet is surfaced too, flagged isAdmin (and is NOT an
    // operational key — that distinction is exactly what guard g2 protects).
    const admin = json.wallets.find((w: any) => w.isAdmin);
    expect(admin, 'GET must surface the admin wallet').toBeTruthy();
    expect(
      await hasPurpose(node.identityId, admin.address, ADMIN_KEY_PURPOSE),
      'admin wallet must have ADMIN purpose on-chain',
    ).toBe(true);
    expect(
      await hasPurpose(node.identityId, admin.address, OPERATIONAL_KEY_PURPOSE),
      'admin wallet must NOT be an operational key',
    ).toBe(false);
  });

  it('POST adds a throwaway wallet → OPERATIONAL on-chain; DELETE removes it (net-zero)', async () => {
    // Throwaway address only — the node never holds/uses this private key, it is
    // purely an extra authorized operational key we add then immediately remove.
    const throwaway = ethers.Wallet.createRandom().address;

    // Pre-condition: definitely not yet an operational key.
    expect(
      await hasPurpose(node.identityId, throwaway, OPERATIONAL_KEY_PURPOSE),
      'throwaway must start unregistered',
    ).toBe(false);

    let added = false;
    try {
      // ── ADD ──────────────────────────────────────────────────────────────
      const addRes = await postJson(node, '/api/operational-wallets', { address: throwaway });
      expect(
        addRes.status,
        `POST add failed: ${JSON.stringify(addRes.json)}`,
      ).toBe(200);
      expect(addRes.json.added).toBe(true);
      expect(ethers.getAddress(addRes.json.address)).toBe(ethers.getAddress(throwaway));
      expect(typeof addRes.json.txHash).toBe('string');
      added = true;

      // On-chain truth: the address now carries the OPERATIONAL purpose (and is
      // NOT an admin key). Poll — the daemon awaits the receipt, but allow for
      // RPC read lag on the shared node.
      await waitFor(
        `throwaway ${throwaway} gains OPERATIONAL purpose on-chain`,
        60_000,
        1_500,
        async () => ((await hasPurpose(node.identityId, throwaway, OPERATIONAL_KEY_PURPOSE)) ? true : null),
      );
      expect(
        await hasPurpose(node.identityId, throwaway, ADMIN_KEY_PURPOSE),
        'added op wallet must not become an admin key',
      ).toBe(false);

      // NOTE: GET /api/operational-wallets enumerates ONLY the node's LOCAL
      // wallet store (~/.dkg/wallets.json) + admin wallet, annotated with
      // on-chain status — it does NOT enumerate the on-chain key set. The
      // throwaway is added on-chain only (never written to wallets.json), so it
      // is intentionally invisible to GET. On-chain `keyHasPurpose` above is the
      // authoritative verification of the add (and GET's local-store scope is
      // also why this transient key perturbs no parallel reader).

      // ── REMOVE (the guard's happy path: g1/g2/g3 all pass for a real op key) ─
      const delRes = await postDelete(node, throwaway);
      expect(
        delRes.status,
        `DELETE remove failed: ${JSON.stringify(delRes.json)}`,
      ).toBe(200);
      expect(delRes.json.removed).toBe(true);
      added = false;

      await waitFor(
        `throwaway ${throwaway} loses OPERATIONAL purpose on-chain`,
        60_000,
        1_500,
        async () => ((await hasPurpose(node.identityId, throwaway, OPERATIONAL_KEY_PURPOSE)) ? null : true),
      );
      expect(
        await hasPurpose(node.identityId, throwaway, OPERATIONAL_KEY_PURPOSE),
        'throwaway must be fully de-authorized',
      ).toBe(false);
    } finally {
      // Isolation safety net: if any assertion above threw while the throwaway
      // was still attached, remove it so node1 is left exactly as found.
      if (added) {
        try {
          await postDelete(node, throwaway);
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  });

  it('DELETE on the node ADMIN key is REJECTED by the guard (no on-chain mutation)', async () => {
    // Resolve the node's admin address from the GET surface (isAdmin flag).
    const { json } = await getJson(node, '/api/operational-wallets');
    const adminEntry = (json.wallets ?? []).find((w: any) => w.isAdmin);
    expect(adminEntry, 'admin wallet must be listed').toBeTruthy();
    const adminAddr: string = adminEntry.address;

    // Pre-state snapshot — must be unchanged after the rejected call.
    const adminWasAdmin = await hasPurpose(node.identityId, adminAddr, ADMIN_KEY_PURPOSE);
    expect(adminWasAdmin, 'admin wallet is an on-chain admin key').toBe(true);

    const res = await postDelete(node, adminAddr);
    // Guard g2 throws "registered on-chain as an ADMIN key" — unclassified →
    // route maps it to 500 (a deterministic guard rejection, not a tx revert).
    expect(res.status, `expected guard rejection, got ${JSON.stringify(res.json)}`).toBe(500);
    expect(JSON.stringify(res.json)).toMatch(/ADMIN key|admin key/i);
    expect(res.json.removed).toBeUndefined();

    // On-chain unchanged: the admin key is intact, still NOT an operational key.
    expect(await hasPurpose(node.identityId, adminAddr, ADMIN_KEY_PURPOSE)).toBe(true);
    expect(await hasPurpose(node.identityId, adminAddr, OPERATIONAL_KEY_PURPOSE)).toBe(false);
  });

  it('DELETE on a never-added random address is REJECTED by the operational-key guard', async () => {
    const stranger = ethers.Wallet.createRandom().address;
    // Pre-state: this address carries no purpose on the node identity at all.
    expect(await hasPurpose(node.identityId, stranger, OPERATIONAL_KEY_PURPOSE)).toBe(false);
    expect(await hasPurpose(node.identityId, stranger, ADMIN_KEY_PURPOSE)).toBe(false);

    const res = await postDelete(node, stranger);
    // Guard g3 throws "not registered on-chain as an operational key" → 500.
    expect(res.status, `expected guard rejection, got ${JSON.stringify(res.json)}`).toBe(500);
    expect(JSON.stringify(res.json)).toMatch(/not registered on-chain as an operational key/i);
    expect(res.json.removed).toBeUndefined();

    // Nothing was created/removed — the address is still purpose-less.
    expect(await hasPurpose(node.identityId, stranger, OPERATIONAL_KEY_PURPOSE)).toBe(false);
    expect(await hasPurpose(node.identityId, stranger, ADMIN_KEY_PURPOSE)).toBe(false);
  });

  it("DELETE on the node's PRIMARY operational wallet is REFUSED (anchors identity)", async () => {
    const { json } = await getJson(node, '/api/operational-wallets');
    const primary = (json.wallets ?? []).find((w: any) => w.isPrimary);
    expect(primary, 'primary op wallet must be listed').toBeTruthy();
    const primaryAddr: string = primary.address;
    expect(await hasPurpose(node.identityId, primaryAddr, OPERATIONAL_KEY_PURPOSE)).toBe(true);

    const res = await postDelete(node, primaryAddr);
    // Guard g1 → route maps the refuse-primary message to 409.
    expect(res.status, `expected primary refusal, got ${JSON.stringify(res.json)}`).toBe(409);
    expect(res.json.error).toBe('CannotRemovePrimaryOperationalWallet');
    expect(res.json.removed).toBeUndefined();

    // Untouched: still an operational key.
    expect(await hasPurpose(node.identityId, primaryAddr, OPERATIONAL_KEY_PURPOSE)).toBe(true);
  });
});

/**
 * DELETE /api/operational-wallets/:address. The shared harness has no DELETE
 * helper, so issue it directly with the node's bearer token (the route gates
 * writes on a node-admin token; the harness reads exactly that from auth.token).
 */
// Domain wrapper over the harness httpDelete primitive: builds the op-wallet path
// (checksummed + URL-encoded) so the five call sites stay unchanged.
const postDelete = (n: DevnetNode, address: string) =>
  httpDelete(n, `/api/operational-wallets/${encodeURIComponent(ethers.getAddress(address))}`);
