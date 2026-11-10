// SPDX-License-Identifier: Apache-2.0
/**
 * ContextGraphs 10.1.0: a publish refused because its author is not a member of
 * the curated graph answers 403 with `AUTHOR_NOT_CONTEXT_GRAPH_MEMBER`, whether
 * the publisher refused it before collecting ACKs or the chain refused it.
 */
import { describe, expect, it } from 'vitest';
import { AuthorNotContextGraphMemberError } from '@origintrail-official/dkg-publisher';
import { respondAuthorNotContextGraphMember } from '../src/daemon/routes/knowledge-assets-error-mapping.js';

const AUTHOR = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';

function fakeResponse() {
  const record = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      record.status = status;
      return res;
    },
    end(body?: string) {
      if (typeof body === 'string') record.body = body;
    },
  } as any;
  return { record, res };
}

describe('respondAuthorNotContextGraphMember', () => {
  it('answers 403 for the publisher\'s refusal before ACK collection', () => {
    const { record, res } = fakeResponse();
    expect(respondAuthorNotContextGraphMember(res, new AuthorNotContextGraphMemberError(42n, AUTHOR))).toBe(true);
    expect(record.status).toBe(403);
    const body = JSON.parse(record.body);
    expect(body.code).toBe('AUTHOR_NOT_CONTEXT_GRAPH_MEMBER');
    expect(body.error).toContain('not a member of context graph 42');
  });

  it('answers 403 for the decoded on-chain revert', () => {
    const { record, res } = fakeResponse();
    const chainRevert = Object.assign(new Error(`execution reverted: AuthorNotContextGraphMember(42, ${AUTHOR})`), {
      code: 'CALL_EXCEPTION',
      revert: { name: 'AuthorNotContextGraphMember', args: [42n, AUTHOR] },
    });
    expect(respondAuthorNotContextGraphMember(res, chainRevert)).toBe(true);
    expect(record.status).toBe(403);
    expect(JSON.parse(record.body).code).toBe('AUTHOR_NOT_CONTEXT_GRAPH_MEMBER');
  });

  it('leaves every other error to the next mapping', () => {
    const { record, res } = fakeResponse();
    const senderGate = Object.assign(new Error('UnauthorizedPublisher(42, 0x01)'), {
      revert: { name: 'UnauthorizedPublisher' },
    });
    expect(respondAuthorNotContextGraphMember(res, senderGate)).toBe(false);
    expect(respondAuthorNotContextGraphMember(res, new Error('boom'))).toBe(false);
    expect(respondAuthorNotContextGraphMember(res, undefined)).toBe(false);
    expect(record.status).toBe(0);
  });
});
