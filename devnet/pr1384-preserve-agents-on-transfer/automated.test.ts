/**
 * PR #1384 — PCA agents PRESERVED across NFT transfer + owner-gated clearAgents.
 *
 * OT-RFC-51 publishing-conviction PCAs are ERC-721 tokens whose accountId ==
 * tokenId (the wrapper mint counter doubles as the accountId — see
 * `DKGPublishingConvictionNFT.createAccount`). Each PCA carries a publishing
 * *agent allow-list*: addresses authorised to draw the account's discounted
 * publishing allowance. Pre-#1384 the NFT transfer hook WIPED that allow-list
 * on every ownership change; #1384 makes the allow-list travel WITH the token
 * and adds an explicit owner-gated `clearAgents` for the new owner to drop an
 * inherited list (or the old owner to wipe it before handing the PCA over).
 *
 * Source verified (devnet worktree, branch test/devnet-1002-coverage):
 *   - DKGPublishingConvictionNFT.sol (10.0.3)
 *       · createAccount(uint96,uint72) → accountId == tokenId == mint counter
 *       · registerAgent(uint256,address)         — owner-gated on the wrapper
 *       · getRegisteredAgents(uint256)→address[] — forwards to PCS, insertion order
 *       · agentToAccountId(address)→uint256      — global reverse map, 0 == unbound
 *       · isAgent(uint256,address)→bool          — forwards to PCS.isRegisteredAgent
 *       · _update(...) hook → PublishingConviction.onTransfer(tokenId,from,to)
 *         on owner→owner transfer (skipped on mint/burn).
 *   - PublishingConviction.sol
 *       · onTransfer(...) ONLY flushes lazy settlement; it does NOT touch the
 *         agent allow-list → agents PRESERVED across transfer. (The stale
 *         "clear every agent" NatSpec on the wrapper's _update is superseded
 *         by this body; PCS.clearAgents' own NatSpec confirms "NOT called on
 *         NFT transfer".)
 *       · clearAgents(uint256) external onlyCurrentPcaOwner(accountId)
 *         — lives on the LOGIC contract (the frozen wrapper hosts no batch
 *           entry point); gated by live `ownerOf(accountId) == msg.sender`,
 *           reverts NotAccountOwner(accountId, caller) otherwise.
 *       · emits AgentsCleared(accountId, caller, clearedCount).
 *   - PublishingConvictionStorage.sol
 *       · addAgent push() → insertion order; agentToAccountId set.
 *       · clearAgents → zeroes agentToAccountId[a] for every a + delete()s the
 *         array → getRegisteredAgents == [] and agentToAccountId(X) == 0.
 *
 * Why a fresh PCA + fresh throwaway agents per `it` (isolation invariant):
 *   `agentToAccountId` is a GLOBAL one-account-per-agent map — PCS.addAgent
 *   reverts AgentAlreadyRegistered if an address is bound anywhere. Every `it`
 *   therefore mints its OWN PCA via createFreshPca (throwaway owner A) and uses
 *   fresh random agent addresses X/Y and a fresh recipient B. Nothing in the
 *   shared sweep depends on these entities, and we never touch a real node's
 *   wallet/identity. No daemon, CLI, or time-warp — this is a pure
 *   contract-layer PR and on-chain reads against the live devnet ARE the
 *   network-observable behaviour.
 *
 * Preconditions: ./scripts/devnet.sh start 6
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import {
  detectDevnet,
  ensureAllIdentities,
  createFreshPca,
  contractAt,
  setEth,
  nextNonce,
  type DevnetState,
} from '../_bootstrap/harness.js';

// Wrapper NFT ABI fragments this suite needs (harness NFT_ABI lacks transferFrom
// / getRegisteredAgents / isAgent). The wrapper name IS in state.addrs.
const NFT_ABI = [
  'function registerAgent(uint256 accountId, address agent) external',
  'function getRegisteredAgents(uint256 accountId) view returns (address[])',
  'function agentToAccountId(address agent) view returns (uint256)',
  'function isAgent(uint256 accountId, address agent) view returns (bool)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function transferFrom(address from, address to, uint256 tokenId) external',
];

// Logic contract ABI fragments. The logic contract is Hub-registered as
// "PublishingConviction" but is NOT in the harness' precomputed state.addrs,
// so we resolve its address via the Hub directly (state.hub carries
// getContractAddress).
const LOGIC_ABI = [
  'function clearAgents(uint256 accountId) external',
  'event AgentsCleared(uint256 indexed accountId, address indexed caller, uint256 cleared)',
  'error NotAccountOwner(uint256 accountId, address caller)',
];

const lc = (a: string): string => a.toLowerCase();
const sortedLc = (xs: string[]): string[] => xs.map(lc).sort();

interface Ctx {
  state: DevnetState;
  nft: ethers.Contract; // wrapper, read-only base handle
  logic: ethers.Contract; // logic, read-only base handle
}

const ctx: { v: Ctx | null } = { v: null };

/** Fresh PCA (owner wallet A) + a freshly-funded throwaway recipient wallet B. */
async function freshPcaAndRecipient(
  state: DevnetState,
): Promise<{ accountId: bigint; A: ethers.Wallet; B: ethers.Wallet }> {
  const { accountId, admin: A } = await createFreshPca(state);
  const B = ethers.Wallet.createRandom().connect(state.provider);
  await setEth(state, B.address, '100');
  return { accountId, A, B };
}

/** Two distinct, never-before-registered agent addresses (never sign). */
function freshAgents(): { X: string; Y: string } {
  return {
    X: ethers.Wallet.createRandom().address,
    Y: ethers.Wallet.createRandom().address,
  };
}

describe('PR #1384 — PCA agents preserved across NFT transfer + clearAgents', () => {
  beforeAll(async () => {
    const state = await detectDevnet(6);
    if (!state) {
      throw new Error(
        'No devnet detected — run ./scripts/devnet.sh start 6 before this suite.',
      );
    }
    await ensureAllIdentities(state, 4);

    const logicAddr: string = await state.hub.getContractAddress('PublishingConviction');
    if (!logicAddr || logicAddr === ethers.ZeroAddress) {
      throw new Error('PublishingConviction logic contract not registered in Hub');
    }

    ctx.v = {
      state,
      nft: contractAt(state, 'DKGPublishingConvictionNFT', NFT_ABI),
      logic: new ethers.Contract(logicAddr, LOGIC_ABI, state.provider),
    };
  }, 240_000);

  it('registers agents {X,Y} on a fresh PCA → bound to its accountId (insertion order, reverse map, membership)', async () => {
    const { state, nft } = ctx.v!;
    const { accountId, A } = await freshPcaAndRecipient(state);
    const { X, Y } = freshAgents();

    // Both agents must be globally unbound before we register them.
    expect(await nft.agentToAccountId(X)).toBe(0n);
    expect(await nft.agentToAccountId(Y)).toBe(0n);

    const nftA = nft.connect(A) as ethers.Contract;
    await (
      await nftA.registerAgent(accountId, X, {
        nonce: await nextNonce(state.provider, A.address),
      })
    ).wait();
    await (
      await nftA.registerAgent(accountId, Y, {
        nonce: await nextNonce(state.provider, A.address),
      })
    ).wait();

    // Reverse map: each agent points back at THIS accountId.
    expect(await nft.agentToAccountId(X)).toBe(accountId);
    expect(await nft.agentToAccountId(Y)).toBe(accountId);

    // Enumeration getter returns exactly {X,Y} (push() → insertion order).
    const agents: string[] = await nft.getRegisteredAgents(accountId);
    expect(sortedLc(agents)).toEqual(sortedLc([X, Y]));

    // Membership getter agrees.
    expect(await nft.isAgent(accountId, X)).toBe(true);
    expect(await nft.isAgent(accountId, Y)).toBe(true);
  });

  it('PRESERVES the agent allow-list across transferFrom A→B (ownerOf flips, agents still bound)', async () => {
    const { state, nft } = ctx.v!;
    const { accountId, A, B } = await freshPcaAndRecipient(state);
    const { X, Y } = freshAgents();

    const nftA = nft.connect(A) as ethers.Contract;
    await (
      await nftA.registerAgent(accountId, X, {
        nonce: await nextNonce(state.provider, A.address),
      })
    ).wait();
    await (
      await nftA.registerAgent(accountId, Y, {
        nonce: await nextNonce(state.provider, A.address),
      })
    ).wait();

    expect(lc(await nft.ownerOf(accountId))).toBe(lc(A.address));

    // accountId == tokenId. Transfer the PCA from A to B; this fires the
    // _update hook → PublishingConviction.onTransfer, which (post-#1384)
    // ONLY flushes lazy settlement and leaves the allow-list intact.
    await (
      await nftA.transferFrom(A.address, B.address, accountId, {
        nonce: await nextNonce(state.provider, A.address),
      })
    ).wait();

    // Ownership moved to B…
    expect(lc(await nft.ownerOf(accountId))).toBe(lc(B.address));

    // …but the agent registrations PERSIST (the core #1384 behaviour).
    expect(await nft.agentToAccountId(X)).toBe(accountId);
    expect(await nft.agentToAccountId(Y)).toBe(accountId);
    const agents: string[] = await nft.getRegisteredAgents(accountId);
    expect(sortedLc(agents)).toEqual(sortedLc([X, Y]));
    expect(await nft.isAgent(accountId, X)).toBe(true);
  });

  it('new owner B can clearAgents → allow-list reset (getter empty, reverse map zeroed) + AgentsCleared emitted', async () => {
    const { state, nft, logic } = ctx.v!;
    const { accountId, A, B } = await freshPcaAndRecipient(state);
    const { X, Y } = freshAgents();

    const nftA = nft.connect(A) as ethers.Contract;
    await (
      await nftA.registerAgent(accountId, X, {
        nonce: await nextNonce(state.provider, A.address),
      })
    ).wait();
    await (
      await nftA.registerAgent(accountId, Y, {
        nonce: await nextNonce(state.provider, A.address),
      })
    ).wait();

    await (
      await nftA.transferFrom(A.address, B.address, accountId, {
        nonce: await nextNonce(state.provider, A.address),
      })
    ).wait();
    // Inherited list is present right up until B explicitly clears it.
    expect((await nft.getRegisteredAgents(accountId)).length).toBe(2);

    // B (the CURRENT owner) clears the whole allow-list via the logic contract.
    const logicB = logic.connect(B) as ethers.Contract;
    const receipt = await (
      await logicB.clearAgents(accountId, {
        nonce: await nextNonce(state.provider, B.address),
      })
    ).wait();

    // AgentsCleared(accountId, B, 2) surfaced from the logic contract.
    let cleared: { accountId: bigint; caller: string; count: bigint } | null = null;
    for (const log of receipt!.logs) {
      try {
        const parsed = logic.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (parsed?.name === 'AgentsCleared') {
          cleared = {
            accountId: parsed.args.accountId as bigint,
            caller: parsed.args.caller as string,
            count: parsed.args.cleared as bigint,
          };
        }
      } catch {
        /* not a logic-contract event */
      }
    }
    expect(cleared).not.toBeNull();
    expect(cleared!.accountId).toBe(accountId);
    expect(lc(cleared!.caller)).toBe(lc(B.address));
    expect(cleared!.count).toBe(2n);

    // Enumeration getter is now empty…
    expect(await nft.getRegisteredAgents(accountId)).toEqual([]);
    // …and the global reverse map is zeroed for both agents (so they could be
    // re-registered against any account again).
    expect(await nft.agentToAccountId(X)).toBe(0n);
    expect(await nft.agentToAccountId(Y)).toBe(0n);
    expect(await nft.isAgent(accountId, X)).toBe(false);
  });

  it('after transfer A→B, the OLD owner A can no longer clearAgents (reverts NotAccountOwner)', async () => {
    const { state, nft, logic } = ctx.v!;
    const { accountId, A, B } = await freshPcaAndRecipient(state);
    const { X } = freshAgents();

    const nftA = nft.connect(A) as ethers.Contract;
    await (
      await nftA.registerAgent(accountId, X, {
        nonce: await nextNonce(state.provider, A.address),
      })
    ).wait();
    await (
      await nftA.transferFrom(A.address, B.address, accountId, {
        nonce: await nextNonce(state.provider, A.address),
      })
    ).wait();
    expect(lc(await nft.ownerOf(accountId))).toBe(lc(B.address));

    // `onlyCurrentPcaOwner` checks live ownerOf BEFORE touching agent state, so
    // A — no longer the owner — is rejected. staticCall surfaces the decoded
    // custom error deterministically without consuming a nonce.
    const logicA = logic.connect(A) as ethers.Contract;
    await expect(logicA.clearAgents.staticCall(accountId)).rejects.toThrow(
      /NotAccountOwner/,
    );

    // The allow-list is therefore untouched by A's failed attempt.
    expect(await nft.agentToAccountId(X)).toBe(accountId);
    expect((await nft.getRegisteredAgents(accountId)).length).toBe(1);
  });
});
