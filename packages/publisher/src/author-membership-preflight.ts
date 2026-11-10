// SPDX-License-Identifier: Apache-2.0
/**
 * Publishing requires membership (ContextGraphs 10.1.0).
 *
 * A curated context graph binds a Knowledge Asset only when the KA's attested
 * author is a member of the graph: on its participant roster, the holder of
 * its NFT, or its EOA / Safe curator. Being an agent, or the owner, of the PCA
 * the graph is bound to does not make an author a member. On chain the rule
 * makes the publish revert `AuthorNotContextGraphMember` after the ACKs were
 * collected; asking the gate first refuses the publish before any core is
 * asked to store or sign anything.
 *
 * The check is best effort. The chain stays authoritative, so the publish goes
 * ahead whenever the gate cannot answer: an adapter without it, a facade
 * before 10.1.0, a read that fails, or a context graph that is not on chain.
 */
import { hasContextGraphAuthorGate } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';

/** Code of {@link AuthorNotContextGraphMemberError}. */
export const AUTHOR_NOT_CONTEXT_GRAPH_MEMBER_CODE = 'AUTHOR_NOT_CONTEXT_GRAPH_MEMBER' as const;

/** The context graph would refuse this author on chain. Deterministic until the graph's roster changes. */
export class AuthorNotContextGraphMemberError extends Error {
  readonly code = AUTHOR_NOT_CONTEXT_GRAPH_MEMBER_CODE;

  constructor(
    readonly contextGraphId: bigint,
    readonly authorAddress: string,
  ) {
    super(
      `Author ${authorAddress} is not a member of context graph ${contextGraphId}. A curated context graph ` +
        'accepts Knowledge Assets only from authors on its participant roster, the holder of its NFT, or its ' +
        "EOA/Safe curator; being an agent or the owner of the graph's PCA does not make an author a member. " +
        "The graph's owner or curator can add the author as a participant agent.",
    );
    this.name = 'AuthorNotContextGraphMemberError';
  }
}

/**
 * Throw {@link AuthorNotContextGraphMemberError} when the context graph's author
 * gate says no to `authorAddress`; otherwise resolve. `contextGraphId` is the
 * on-chain id (a numeric string or bigint); anything else is a local publish
 * and is not checked.
 */
export async function assertAuthorIsContextGraphMember(
  chain: unknown,
  contextGraphId: string | bigint,
  authorAddress: string | undefined,
): Promise<void> {
  if (!authorAddress || !ethers.isAddress(authorAddress) || !hasContextGraphAuthorGate(chain)) return;
  let id: bigint;
  try {
    id = BigInt(contextGraphId);
  } catch {
    return;
  }
  if (id <= 0n) return;
  let allowed: boolean | undefined;
  try {
    allowed = await chain.isAuthorizedAuthor(id, authorAddress);
  } catch {
    return;
  }
  if (allowed === false) {
    throw new AuthorNotContextGraphMemberError(id, ethers.getAddress(authorAddress));
  }
}
