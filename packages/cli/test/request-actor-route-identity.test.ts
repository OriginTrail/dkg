import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createAllowedHttpAuthentication } from '../src/auth.js';
import {
  handleRequest,
  type HandleRequestInput,
} from '../src/daemon/handle-request.js';

const TRUSTED_ADDRESS = '0x1111111111111111111111111111111111111111';
const REVOKED_ADDRESS = '0x2222222222222222222222222222222222222222';
const REVOKED_TOKEN = 'revoked-agent-token';

function request(method: string, path: string) {
  return Object.assign(Readable.from([]), {
    method,
    url: path,
    headers: {
      host: '127.0.0.1',
      authorization: `Bearer ${REVOKED_TOKEN}`,
    },
    __dkgPrebufferedBody: Buffer.from('{}', 'utf8'),
  });
}

function response() {
  return {
    statusCode: 0,
    body: '',
    writableEnded: false,
    writeHead(status: number) {
      this.statusCode = status;
      return this;
    },
    end(body?: string) {
      this.body = body ?? '';
      this.writableEnded = true;
      return this;
    },
  };
}

function authentication() {
  return createAllowedHttpAuthentication({
    mode: 'disabled',
    presentedToken: REVOKED_TOKEN,
  });
}

describe('canonical request actor route identity', () => {
  it('does not let an unaccepted bearer alter /api/agent/identity', async () => {
    const req = request('GET', '/api/agent/identity');
    const res = response();
    const resolveAgentAddress = vi.fn((token?: string) => (
      token === REVOKED_TOKEN ? REVOKED_ADDRESS : TRUSTED_ADDRESS
    ));
    const agent = {
      resolveAgentAddress,
      listLocalAgents: () => [{ agentAddress: TRUSTED_ADDRESS, name: 'trusted-agent', framework: 'test' }],
      nodeName: 'node',
      nodeFramework: 'node-framework',
      peerId: '12D3KooWTrusted',
      publisher: { getIdentityId: () => 7n },
    };

    await handleRequest({
      req,
      res,
      agent,
      authentication: authentication(),
    } as unknown as HandleRequestInput);

    expect(resolveAgentAddress).toHaveBeenCalledTimes(1);
    expect(resolveAgentAddress).toHaveBeenCalledWith(undefined);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      agentAddress: TRUSTED_ADDRESS,
      name: 'trusted-agent',
    });
  });

  it('does not let an unaccepted bearer alter sign-join identity', async () => {
    const contextGraphId = 'private-cg';
    const path = `/api/context-graph/${contextGraphId}/sign-join`;
    const req = request('POST', path);
    const res = response();
    const resolveAgentAddress = vi.fn((token?: string) => (
      token === REVOKED_TOKEN ? REVOKED_ADDRESS : TRUSTED_ADDRESS
    ));
    const signJoinRequest = vi.fn(async (_cg: string, agentAddress: string) => ({
      agentAddress,
      signature: '0xsigned',
    }));
    const agent = { resolveAgentAddress, signJoinRequest };

    await handleRequest({
      req,
      res,
      agent,
      authentication: authentication(),
    } as unknown as HandleRequestInput);

    expect(resolveAgentAddress).toHaveBeenCalledTimes(1);
    expect(resolveAgentAddress).toHaveBeenCalledWith(undefined);
    expect(signJoinRequest).toHaveBeenCalledWith(contextGraphId, TRUSTED_ADDRESS);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).agentAddress).toBe(TRUSTED_ADDRESS);
  });
});
