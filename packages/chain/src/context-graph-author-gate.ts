// SPDX-License-Identifier: Apache-2.0
/**
 * ContextGraphs 10.1.0 author gate, chain side.
 *
 * A curated context graph binds a Knowledge Asset only when the KA's
 * EIP-712-attested author is a member of the graph: on its participant
 * roster, the holder of its NFT, or (EOA / Safe curator mode) its curator.
 * Being an agent, or the owner, of the PCA the graph is bound to is not
 * membership. `ContextGraphs.isAuthorizedAuthor(cgId, author)` is the view;
 * `ContextGraphs.registerKnowledgeAsset` enforces it, so a non-member author
 * makes `KnowledgeAssetsLifecycle.publish` revert
 * `AuthorNotContextGraphMember(cgId, author)`.
 *
 * Who SENDS (and pays for) the publish is the separate, unchanged sender gate
 * (`isAuthorizedPublisher`): a payer that is not a member may still submit a
 * member's KA. Facades before 10.1.0 have neither the view nor the rule.
 */
import { enrichEvmError, errorCode, errorMessage } from './evm-adapter-errors.js';

/** The custom error ContextGraphs >= 10.1.0 reverts with when the author is not a member. */
export const AUTHOR_NOT_CONTEXT_GRAPH_MEMBER_ERROR = 'AuthorNotContextGraphMember' as const;

/**
 * An adapter that can ask the author gate. Optional chain capability, kept out
 * of `ChainAdapter` itself: an adapter without it, like a facade before 10.1.0,
 * has no gate to ask, and the chain stays authoritative.
 */
export interface ContextGraphAuthorGate {
  /**
   * Whether a Knowledge Asset whose EIP-712-attested author is `author` may be
   * published into `contextGraphId` (`ContextGraphs.isAuthorizedAuthor`). A
   * curated graph admits only member authors; an open graph admits any author;
   * unknown or deactivated ids admit none. Resolves `undefined` when the
   * deployed ContextGraphs predates the gate (< 10.1.0). Rejects on transport
   * failures.
   */
  isAuthorizedAuthor(contextGraphId: bigint, author: string): Promise<boolean | undefined>;
}

/** Whether `chain` exposes the author gate. */
export function hasContextGraphAuthorGate(chain: unknown): chain is ContextGraphAuthorGate {
  return typeof (chain as Partial<ContextGraphAuthorGate> | null | undefined)?.isAuthorizedAuthor === 'function';
}

/**
 * True for the shapes a call takes when the deployed contract has no such
 * view (no matching selector and no fallback): a revert without any revert
 * data, an empty `0x` result that does not decode, or an explicit selector
 * message from the node. `isAuthorizedAuthor` never reverts by itself (every
 * read it makes is bounds-checked first), so on a facade that has the view
 * none of these shapes can come from the view; they mean it is absent.
 * A revert that carries data or a reason is never "absent".
 */
export function isAbsentContractViewError(err: unknown): boolean {
  if (err instanceof Error) enrichEvmError(err);
  const code = errorCode(err);
  const message = errorMessage(err).toLowerCase();
  if (message.includes('function selector') || message.includes('selector not recognized')) return true;
  if (code === 'BAD_DATA') {
    return message.includes('could not decode result data') && message.includes('value="0x"');
  }
  if (code !== 'CALL_EXCEPTION') return false;
  const shape = err as { data?: unknown; reason?: unknown };
  const carriesRevert =
    (shape.data != null && shape.data !== '0x') ||
    (typeof shape.reason === 'string' && shape.reason.length > 0);
  return !carriesRevert && message.includes('missing revert data');
}
