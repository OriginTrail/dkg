/**
 * enrichEvmError — RPC format robustness matrix.
 *
 * Audit findings covered:
 *
 *   CH-10 (HIGH) — `enrichEvmError` is only tested against the hardhat-style
 *                  `data="0x..."` substring today. Real-world ethers error
 *                  messages vary a lot by RPC provider:
 *
 *                    • Hardhat (HardhatEthersProvider):
 *                      `execution reverted (unknown custom error) (action="call",
 *                       data="0xabcdef...", reason=null, transaction={...})`
 *
 *                    • Geth / op-geth (stock JSON-RPC):
 *                      `execution reverted` + `error.data = "0x..."` as a
 *                      structured field — ethers wraps this as
 *                      `data: "0x..."` (no equals, no quotes around the key).
 *
 *                    • Infura / Alchemy (paid hosted RPC):
 *                      `execution reverted: <reason>` with payload under
 *                      `error.data = { originalError: { data: "0x..." } }`;
 *                      ethers surfaces the inner `data="0x..."` but often
 *                      also emits `errorData="0x..."` in the summary.
 *
 *                  Today's regex `/data="(0x[0-9a-fA-F]+)"/` will only
 *                  match the hardhat-shaped path. The geth-style (no quotes)
 *                  path and the `errorData=` path go through unmodified.
 *                  Downstream callers log the raw message and can leak
 *                  `0x0000...` selectors to users (#159 class).
 *
 *                  The Hardhat-shape test is already green (exists in
 *                  `evm-adapter.unit.test.ts`); the non-hardhat shapes below
 *                  are expected to STAY RED until `enrichEvmError` is
 *                  generalized.
 *
 * Per QA policy: the red tests ARE the finding — see BUGS_FOUND.md CH-10.
 */
import { describe, it, expect } from 'vitest';
import { Interface } from 'ethers';
import {
  enrichEvmError,
  decodeEvmError,
  isTooLowAllowanceError,
  getKaIdAlreadyMintedKaId,
} from '../src/evm-adapter.js';

const iface = new Interface([
  'error BatchNotFound(uint256 batchId)',
  'error InvalidKARange(uint64 startKAId, uint64 endKAId)',
  'error NotBatchPublisher(uint256 batchId, address caller)',
]);

const BATCH_NOT_FOUND_HEX = iface.encodeErrorResult('BatchNotFound', [42n]);
const tooLowAllowanceIface = new Interface([
  'error TooLowAllowance(address tokenAddress, uint256 allowance, uint256 expected)',
]);
const TOO_LOW_ALLOWANCE_HEX = tooLowAllowanceIface.encodeErrorResult('TooLowAllowance', [
  '0x00000000000000000000000000000000000000aa',
  0n,
  1n,
]);

describe('enrichEvmError — decoder works on raw custom error hex [CH-10]', () => {
  it('decodeEvmError returns the error name for a known selector', () => {
    const out = decodeEvmError(BATCH_NOT_FOUND_HEX);
    expect(out?.name).toBe('BatchNotFound');
  });
});

describe('enrichEvmError — raw ethers/provider fields', () => {
  it('decodes direct raw provider data into TooLowAllowance metadata', () => {
    const err = {
      message: 'execution reverted (unknown custom error)',
      data: TOO_LOW_ALLOWANCE_HEX,
    };

    const name = enrichEvmError(err);

    expect(name).toBe('TooLowAllowance');
    expect(err.message).toContain('TooLowAllowance');
    expect((err as any).revert?.name).toBe('TooLowAllowance');
    expect(isTooLowAllowanceError(err)).toBe(true);
  });

  it('walks common provider wrappers without scanning arbitrary fields', () => {
    const err = {
      message: 'execution reverted (unknown custom error)',
      info: {
        error: {
          data: TOO_LOW_ALLOWANCE_HEX,
        },
      },
    };

    const name = enrichEvmError(err);

    expect(name).toBe('TooLowAllowance');
    expect((err as any).revert?.name).toBe('TooLowAllowance');
    expect(isTooLowAllowanceError(err)).toBe(true);

    const arbitrary = {
      message: 'execution reverted (unknown custom error)',
      randomEnvelope: {
        data: TOO_LOW_ALLOWANCE_HEX,
      },
    };
    expect(enrichEvmError(arbitrary)).toBeNull();
    expect((arbitrary as any).revert).toBeUndefined();
  });
});

describe('enrichEvmError — Hardhat-shape error message [CH-10]', () => {
  it('rewrites `unknown custom error data="0x..."` into the decoded name', () => {
    const err = new Error(
      `execution reverted (unknown custom error) (action="call", data="${BATCH_NOT_FOUND_HEX}", reason=null)`,
    );
    const name = enrichEvmError(err);
    expect(name).toBe('BatchNotFound');
    expect(err.message).toContain('BatchNotFound');
    expect(err.message).not.toContain('unknown custom error');
  });
});

describe('enrichEvmError — Geth-shape error message [CH-10]', () => {
  // PROD-BUG candidate: ethers relays geth revert data as `data: "0x..."`
  // (key: value style, space after colon, no `="` sequence). Today's regex
  // /data="(0x[0-9a-fA-F]+)"/ does NOT match. Expected behaviour: the
  // error should still be decoded and the message enriched.
  it('decodes revert data when ethers surfaces it in `data: "0x..."` form', () => {
    const err = new Error(
      `execution reverted (unknown custom error, data: "${BATCH_NOT_FOUND_HEX}")`,
    );
    const name = enrichEvmError(err);
    // PROD-BUG: returns null today — regex requires `="`. See CH-10.
    expect(name).toBe('BatchNotFound');
    expect(err.message).toContain('BatchNotFound');
  });

  it('decodes revert data when ethers surfaces it in `error.data=0x..` form (no quotes)', () => {
    const err = new Error(
      `execution reverted: missing revert data (data=${BATCH_NOT_FOUND_HEX})`,
    );
    const name = enrichEvmError(err);
    // PROD-BUG: the unquoted case is not handled either.
    expect(name).toBe('BatchNotFound');
  });
});

describe('enrichEvmError — Infura/Alchemy-shape error message [CH-10]', () => {
  // ethers v6 often carries the selector under `errorData=` in the
  // normalized error. Regex today matches only `data=`.
  it('decodes revert data when error carries it under `errorData="0x..."`', () => {
    const err = new Error(
      `execution reverted (unknown custom error) (errorData="${BATCH_NOT_FOUND_HEX}", errorArgs=null)`,
    );
    const name = enrichEvmError(err);
    // PROD-BUG: `errorData=` path is not handled.
    expect(name).toBe('BatchNotFound');
  });

  it('decodes revert data inside nested originalError envelope (typical of hosted RPC)', () => {
    // Infura / Alchemy wrap the provider's original error as a JSON
    // blob that gets stringified into ethers' error message. A naive
    // substring search still finds `data="0x..."` only if the outer wrap
    // emits that shape; many providers emit `"data":"0x..."` (JSON).
    const err = new Error(
      `processing response error (body='{"error":{"code":3,"data":"${BATCH_NOT_FOUND_HEX}"}}')`,
    );
    const name = enrichEvmError(err);
    // PROD-BUG: JSON-embedded `"data":"0x..."` is not handled.
    expect(name).toBe('BatchNotFound');
  });
});

describe('enrichEvmError — regression guards [CH-10]', () => {
  it('returns null on a plain network error with no revert data', () => {
    expect(enrichEvmError(new Error('connect ECONNREFUSED 127.0.0.1:8545'))).toBeNull();
  });

  it('returns null when data is present but does not match any known selector', () => {
    const err = new Error('execution reverted (unknown custom error) (data="0xdeadbeef")');
    const name = enrichEvmError(err);
    expect(name).toBeNull();
    // And must NOT rewrite the message in that case (logging invariant).
    expect(err.message).toContain('unknown custom error');
  });

  it('returns null when passed a non-Error value (defensive)', () => {
    expect(enrichEvmError(null as any)).toBeNull();
    expect(enrichEvmError('string reason' as any)).toBeNull();
    expect(enrichEvmError({ message: 'plain object' } as any)).toBeNull();
  });

  it('embeds the decoded argument list when the error has parameters (operator-friendly log)', () => {
    const data = iface.encodeErrorResult('NotBatchPublisher', [
      7n,
      '0x00000000000000000000000000000000000000aa',
    ]);
    const err = new Error(`execution reverted (unknown custom error, data="${data}")`);
    enrichEvmError(err);
    // The exact format is `Name(arg0, arg1, ...)` — pin it so operators'
    // grep tooling does not silently break on a reformat.
    expect(err.message).toMatch(/NotBatchPublisher\(7, 0x[0-9a-fA-F]{40}\)/);
  });
});

// ---------------------------------------------------------------------------
// getKaIdAlreadyMintedKaId — adopt-existing-mint classifier
// (see dkg-publisher adoptExistingMintOrRethrow). The decode goes through the
// AGGREGATE error interface built from packages/chain/abi/*.json — the
// KaIdAlreadyMinted(uint256) fragment ships in DKGKnowledgeAssets.json, which
// is what makes the local encode below decodable in production. The local
// Interface here is used only to ENCODE the revert payload, mirroring the
// carrier-construction idiom of the CH-10 suites above.
// ---------------------------------------------------------------------------

const kaMintedIface = new Interface(['error KaIdAlreadyMinted(uint256 kaId)']);
// Realistic packed kaId ((author << 96) | number) — deliberately far beyond
// Number.MAX_SAFE_INTEGER so any float round-trip in the classifier would
// corrupt it and fail the strict bigint equality below.
const PACKED_KA_ID =
  (BigInt('0x70997970C51812dc3A010C7d01b50e0d17dc79C8') << 96n) | 41n;
const KA_ALREADY_MINTED_HEX = kaMintedIface.encodeErrorResult('KaIdAlreadyMinted', [
  PACKED_KA_ID,
]);

describe('getKaIdAlreadyMintedKaId — adopt-existing-mint classifier', () => {
  it('decodes a direct KaIdAlreadyMinted CALL_EXCEPTION revert into the minted kaId (bigint)', () => {
    // Hardhat-shape ethers CALL_EXCEPTION: revert data embedded in the message.
    const err = Object.assign(
      new Error(
        `execution reverted (unknown custom error) (action="call", data="${KA_ALREADY_MINTED_HEX}", reason=null)`,
      ),
      { code: 'CALL_EXCEPTION' },
    );
    expect(getKaIdAlreadyMintedKaId(err)).toBe(PACKED_KA_ID);
    // The classifier enriches defensively — the structured revert must now be
    // stamped (decoded via the aggregate DKGKnowledgeAssets ABI, not a local one).
    expect((err as unknown as { revert?: { name?: string } }).revert?.name).toBe(
      'KaIdAlreadyMinted',
    );

    // Geth-shape structured field carrier decodes identically.
    const raw = {
      message: 'execution reverted (unknown custom error)',
      data: KA_ALREADY_MINTED_HEX,
    };
    expect(getKaIdAlreadyMintedKaId(raw)).toBe(PACKED_KA_ID);
  });

  it('recurses into err.cause when only the nested error carries the revert', () => {
    // Pre-stamped structured revert on the CAUSE only — no raw revert data
    // anywhere, so the outer enrich pass finds nothing and the classifier
    // must take its explicit `err.cause` recursion branch.
    const preStamped = {
      message: 'wrapped by an upstream retry layer (no data fields here)',
      cause: {
        revert: { name: 'KaIdAlreadyMinted', args: [PACKED_KA_ID] },
      },
    };
    expect(getKaIdAlreadyMintedKaId(preStamped)).toBe(PACKED_KA_ID);

    // Raw revert data nested under cause (typical ethers v6 wrap) decodes too.
    const rawNested = {
      message: 'could not coalesce error',
      cause: Object.assign(
        new Error('execution reverted (unknown custom error)'),
        { code: 'CALL_EXCEPTION', data: KA_ALREADY_MINTED_HEX },
      ),
    };
    expect(getKaIdAlreadyMintedKaId(rawNested)).toBe(PACKED_KA_ID);
  });

  it('returns undefined for a different custom-error revert (TooLowAllowance)', () => {
    const err = {
      message: 'execution reverted (unknown custom error)',
      data: TOO_LOW_ALLOWANCE_HEX,
    };
    expect(getKaIdAlreadyMintedKaId(err)).toBeUndefined();
    // Not silently undecoded — it IS decoded, just not the error we adopt on.
    expect((err as unknown as { revert?: { name?: string } }).revert?.name).toBe(
      'TooLowAllowance',
    );
    expect(isTooLowAllowanceError(err)).toBe(true);
  });

  it('returns undefined for undecodable / garbage revert data', () => {
    expect(
      getKaIdAlreadyMintedKaId(
        new Error('execution reverted (unknown custom error) (data="0xdeadbeef")'),
      ),
    ).toBeUndefined();
    expect(
      getKaIdAlreadyMintedKaId({ message: 'execution reverted', data: '0xdeadbeef' }),
    ).toBeUndefined();
    expect(getKaIdAlreadyMintedKaId(new Error('connect ECONNREFUSED 127.0.0.1:8545'))).toBeUndefined();
    // Non-object carriers must not throw (deliberately NO string-matching
    // fallback — adoption is state-changing and requires the structured decode).
    expect(getKaIdAlreadyMintedKaId(null)).toBeUndefined();
    expect(getKaIdAlreadyMintedKaId(undefined)).toBeUndefined();
    expect(getKaIdAlreadyMintedKaId('KaIdAlreadyMinted(42)')).toBeUndefined();
    // A stamped revert whose args are garbage must not throw either.
    expect(
      getKaIdAlreadyMintedKaId({
        revert: { name: 'KaIdAlreadyMinted', args: ['not-a-number'] },
      }),
    ).toBeUndefined();
  });
});
