// SPDX-License-Identifier: Apache-2.0
/**
 * ContextGraphs 10.1.0: the publisher asks the author gate before it collects
 * ACKs, refuses a non-member author with a typed error, and otherwise leaves
 * the decision to the chain.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  AUTHOR_NOT_CONTEXT_GRAPH_MEMBER_CODE,
  AuthorNotContextGraphMemberError,
  assertAuthorIsContextGraphMember,
} from '../src/author-membership-preflight.js';

const AUTHOR = '0x8ba1f109551bd432803012645ac136ddd64dba72';

function gate(answer: boolean | undefined | Error) {
  const calls: Array<[bigint, string]> = [];
  return {
    calls,
    async isAuthorizedAuthor(contextGraphId: bigint, author: string): Promise<boolean | undefined> {
      calls.push([contextGraphId, author]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

describe('assertAuthorIsContextGraphMember', () => {
  it('refuses an author the graph says is not a member, with a typed, checksummed error', async () => {
    const chain = gate(false);
    const refusal = await assertAuthorIsContextGraphMember(chain, '42', AUTHOR).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(AuthorNotContextGraphMemberError);
    const error = refusal as AuthorNotContextGraphMemberError;
    expect(error.code).toBe(AUTHOR_NOT_CONTEXT_GRAPH_MEMBER_CODE);
    expect(error.contextGraphId).toBe(42n);
    expect(error.authorAddress).toBe(ethers.getAddress(AUTHOR));
    expect(error.message).toContain('not a member of context graph 42');
    expect(chain.calls).toEqual([[42n, AUTHOR]]);
  });

  it('lets a member author through', async () => {
    await expect(assertAuthorIsContextGraphMember(gate(true), 42n, AUTHOR)).resolves.toBeUndefined();
  });

  it('leaves the decision to the chain when the gate cannot answer', async () => {
    // A facade before 10.1.0 has no gate; a failed read proves nothing.
    await expect(assertAuthorIsContextGraphMember(gate(undefined), '42', AUTHOR)).resolves.toBeUndefined();
    await expect(assertAuthorIsContextGraphMember(gate(new Error('RPC timeout')), '42', AUTHOR)).resolves.toBeUndefined();
    // An adapter without the capability.
    await expect(assertAuthorIsContextGraphMember({}, '42', AUTHOR)).resolves.toBeUndefined();
  });

  it('does not ask for local publishes, unusable ids or a missing author', async () => {
    const chain = gate(false);
    await assertAuthorIsContextGraphMember(chain, 'devnet-test', AUTHOR);
    await assertAuthorIsContextGraphMember(chain, '0', AUTHOR);
    await assertAuthorIsContextGraphMember(chain, '-3', AUTHOR);
    await assertAuthorIsContextGraphMember(chain, '42', undefined);
    await assertAuthorIsContextGraphMember(chain, '42', 'not-an-address');
    expect(chain.calls).toEqual([]);
  });
});
