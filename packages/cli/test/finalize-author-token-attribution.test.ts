/**
 * F1 regression — custodial authorship attribution on the create/finalize path.
 *
 * `resolveFinalizeOptions` is the shared author/seal-options resolver for both
 * the atomic `POST /api/knowledge-assets` (create + auto-finalize) and the
 * dedicated `POST /api/knowledge-assets/:name/wm/finalize` routes. It must
 * attribute authorship to the request's agent-scoped bearer token when the body
 * doesn't carry an explicit author, matching lifecycle VM publish attribution.
 *
 * Before the fix it ignored the token, so a custodial agent's create+finalize
 * sealed under the node's own signer and the on-chain author came out as the
 * node's operational wallet instead of the agent (surfaced on a devnet run).
 */
import { describe, it, expect } from 'vitest';
import type { ServerResponse } from 'node:http';
import { resolveFinalizeOptions } from '../src/daemon/routes/knowledge-assets.js';

// jsonResponse is only invoked on a validation error — none of these happy-path
// cases trigger one. Capture any call so an unexpected error surfaces loudly
// instead of as a silent `null` return.
function stubRes(): { res: ServerResponse; errors: Array<{ code: number }> } {
  const errors: Array<{ code: number }> = [];
  const res = {
    headersSent: false,
    statusCode: 0,
    setHeader() {},
    writeHead(code: number) {
      (res as { statusCode: number }).statusCode = code;
      return res;
    },
    end() {
      errors.push({ code: (res as { statusCode: number }).statusCode });
    },
  } as unknown as ServerResponse;
  return { res, errors };
}

const TOKEN_AGENT = `0x${'ab'.repeat(20)}`;
const BODY_AGENT = `0x${'cd'.repeat(20)}`;

describe('resolveFinalizeOptions — token authorship attribution (F1)', () => {
  it('attributes authorship to the agent-scoped token when the body omits an author', () => {
    const { res, errors } = stubRes();
    const out = resolveFinalizeOptions({}, res, TOKEN_AGENT);
    expect(errors).toEqual([]);
    expect(out).not.toBeNull();
    expect((out as Record<string, unknown>).authorAgentAddress).toBe(TOKEN_AGENT);
  });

  it('rejects an explicit body authorAgentAddress that differs from the token agent', () => {
    const { res, errors } = stubRes();
    const out = resolveFinalizeOptions({ authorAgentAddress: BODY_AGENT }, res, TOKEN_AGENT);
    expect(out).toBeNull();
    expect(errors).toEqual([{ code: 403 }]);
  });

  it('canonicalizes an explicit body authorAgentAddress that matches the token agent with different casing', () => {
    const mixedCaseTokenAgent = `0x${'AB'.repeat(20)}`;
    const { res, errors } = stubRes();
    const out = resolveFinalizeOptions({ authorAgentAddress: mixedCaseTokenAgent }, res, TOKEN_AGENT);
    expect(errors).toEqual([]);
    expect((out as Record<string, unknown>).authorAgentAddress).toBe(TOKEN_AGENT);
  });

  it('rejects a pre-signed author attestation whose address differs from the token agent', () => {
    const { res, errors } = stubRes();
    const out = resolveFinalizeOptions({
      preSignedAuthorAttestation: {
        address: BODY_AGENT,
        reservedKaId: '1',
        signature: { r: `0x${'11'.repeat(32)}`, vs: `0x${'22'.repeat(32)}` },
      },
    }, res, TOKEN_AGENT);
    expect(out).toBeNull();
    expect(errors).toEqual([{ code: 403 }]);
  });

  it('does NOT auto-attribute for a node-level/admin token (undefined agent)', () => {
    // resolveAgentByToken returns undefined for admin/node tokens → no author
    // override → publisher signs as itself (pre-fix default preserved).
    const { res, errors } = stubRes();
    const out = resolveFinalizeOptions({}, res, undefined);
    expect(errors).toEqual([]);
    expect(out).not.toBeNull();
    expect((out as Record<string, unknown>).authorAgentAddress).toBeUndefined();
  });
});
