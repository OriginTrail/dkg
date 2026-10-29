import { operationalSigningOf, type AuthorSigner, type ChainAdapter } from '@origintrail-official/dkg-chain';

/** Signs an author attestation (EIP-712 typed data). */
export type AuthorAttestationSigner = Pick<AuthorSigner, 'signTypedData'>;

/**
 * The author of what a publisher publishes without an agent override
 * (RFC-001 §9): its address, and its signer, looked up only when it signs.
 */
export interface FallbackAuthor {
  readonly address: string;
  signer(): Promise<AuthorAttestationSigner | undefined>;
}

/**
 * The fallback-author policy of a publisher configured with `authorSigner` over
 * `chain`, decided once, as the one resolution its address discovery and its
 * signing share: the configured author; nobody when `authorSigner` is `null`,
 * or when it is omitted over a chain whose wallets sign externally (a paying
 * wallet never authors); otherwise the publisher's own wallet, whose address
 * and signer the publisher resolves when asked.
 */
export function fallbackAuthorResolver(
  authorSigner: Pick<AuthorSigner, 'address' | 'signTypedData'> | null | undefined,
  chain: Pick<ChainAdapter, 'operationalSigning'>,
  publisherAddress: () => Promise<string | undefined>,
  publisherSigner: (address: string) => Promise<AuthorAttestationSigner | undefined>,
): () => Promise<FallbackAuthor | undefined> {
  if (authorSigner) {
    const configured: FallbackAuthor = { address: authorSigner.address, signer: async () => authorSigner };
    return async () => configured;
  }
  if (authorSigner === null || operationalSigningOf(chain)?.external === true) return async () => undefined;
  return async () => {
    const address = await publisherAddress();
    return address ? { address, signer: () => publisherSigner(address) } : undefined;
  };
}
