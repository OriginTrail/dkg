import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createServer, type Server} from 'node:http';
import {handleContextGraphRoutes} from '../src/daemon/routes/context-graph.js';
import {requestAuthentication} from './_helpers/request-authentication.js';

describe('targeted Context Graph authority diagnostics', () => {
  let server: Server;
  let origin: string;
  const graphId = '0x1111111111111111111111111111111111111111/jpb-data';
  const path = '/api/context-graph/' + encodeURIComponent(graphId) + '/authority';
  const agent = {
    contextGraphExists: vi.fn(), getExplicitAccessPolicy: vi.fn(),
    getContextGraphCurator: vi.fn(), getContextGraphOnChainId: vi.fn(),
    getContextGraphAllowedAgents: vi.fn(), listContextGraphs: vi.fn(),
  };
  beforeEach(async () => {
    vi.resetAllMocks();
    agent.contextGraphExists.mockResolvedValue(true);
    agent.getExplicitAccessPolicy.mockResolvedValue('private');
    agent.getContextGraphCurator.mockResolvedValue('did:dkg:agent:owner');
    agent.getContextGraphOnChainId.mockResolvedValue(null);
    agent.getContextGraphAllowedAgents.mockResolvedValue(['owner']);
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      const authentication = token === 'admin' ? requestAuthentication({kind:'nodeOperator', token})
        : token === 'agent' ? requestAuthentication({kind:'agent', token, agentAddress:'owner'})
        : requestAuthentication({kind:'anonymous'});
      await handleContextGraphRoutes({req, res, url, path:url.pathname, agent, authentication,
        config:{auth:{enabled:true}}} as any);
      if (!res.writableEnded) {res.writeHead(404); res.end('{}');}
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test listener');
    origin = 'http://127.0.0.1:' + address.port;
  });
  afterEach(async () => {await new Promise<void>(resolve => server.close(() => resolve()));});
  const request = async (token?: string, target = path) => {
    const response = await fetch(origin + target, {headers:token ? {authorization:'Bearer ' + token} : {}});
    return {status:response.status, body:await response.json()};
  };
  it('reads only the requested graph without enumerating graphs', async () => {
    expect(await request('admin')).toEqual({status:200, body:{contextGraphId:graphId,
      accessPolicy:'private', curator:'did:dkg:agent:owner', onChainId:null, allowedAgents:['owner']}});
    for (const lookup of [agent.contextGraphExists, agent.getExplicitAccessPolicy, agent.getContextGraphCurator,
      agent.getContextGraphOnChainId]) expect(lookup).toHaveBeenCalledWith(graphId, {signal:expect.any(AbortSignal)});
    expect(agent.getContextGraphAllowedAgents).toHaveBeenCalledWith(graphId);
    expect(agent.listContextGraphs).not.toHaveBeenCalled();
  });
  it('rejects agent and anonymous callers before disclosing existence', async () => {
    expect((await request('agent')).status).toBe(403);
    expect((await request()).status).toBe(403);
    expect(agent.contextGraphExists).not.toHaveBeenCalled();
  });
  it('reports missing graphs and malformed IDs', async () => {
    agent.contextGraphExists.mockResolvedValue(false);
    expect(await request('admin')).toEqual({status:404, body:{code:'CONTEXT_GRAPH_NOT_FOUND'}});
    expect((await request('admin', '/api/context-graph/%ZZ/authority')).status).toBe(400);
    expect(agent.getExplicitAccessPolicy).not.toHaveBeenCalled();
  });
  it('rereads changes to privacy, ownership, registration and membership on every request', async () => {
    await request('admin');
    agent.getExplicitAccessPolicy.mockResolvedValue('public');
    agent.getContextGraphCurator.mockResolvedValue('did:dkg:agent:other');
    agent.getContextGraphOnChainId.mockResolvedValue('42');
    agent.getContextGraphAllowedAgents.mockResolvedValue(['other']);
    expect((await request('admin')).body).toMatchObject({accessPolicy:'public',
      curator:'did:dkg:agent:other', onChainId:'42', allowedAgents:['other']});
    expect(agent.getExplicitAccessPolicy).toHaveBeenCalledTimes(2);
  });
  it('keeps an unspecified policy unknown and fails closed on lookup errors', async () => {
    agent.getExplicitAccessPolicy.mockResolvedValue(null);
    expect((await request('admin')).body).toMatchObject({accessPolicy:null});
    for (const lookup of [agent.contextGraphExists, agent.getExplicitAccessPolicy, agent.getContextGraphCurator,
      agent.getContextGraphOnChainId, agent.getContextGraphAllowedAgents]) {
      lookup.mockRejectedValueOnce(new Error('private upstream detail'));
      expect(await request('admin')).toEqual({status:503, body:{code:'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE'}});
    }
  });
});
