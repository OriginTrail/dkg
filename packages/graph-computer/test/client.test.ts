import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Wallet, verifyMessage } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentHttpSigningMessage } from '../../cli/src/agent-http-signing.js';
import { verifyAgentDelegation } from '../../agent/src/auth/agent-delegation.js';
import { GraphComputer, GraphComputerError, type GraphComputerOptions } from '../src/index.js';
import { sha256 } from '../src/signing.js';
import { boundSemanticInvocationScope } from '../../cli/src/semantic-runtime-bound-invocation.js';

const wallet = new Wallet('0x' + '01'.padStart(64, '0'));
const operation = { graphId: 'private-data', operationIri: 'urn:example:read-devices' };
const peerId = 'peer-client';
const executorPeerId = 'peer-executor';
const signer = { getAddress: () => wallet.getAddress(), signMessage: (m: string | Uint8Array) => wallet.signMessage(m) };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers });
const receipt = (id: string) => ({ invocationId: id, executionIri: `urn:sr:execution:${id}`, executionLayer: 'wm', persisted: true, outputs: ['{"bindings":[{"device":"urn:device:1","value":"\\\"21.5\\\""}]}', 'plain text'] });
const entry = { contextGraphId: operation.graphId, operationIri: operation.operationIri, revision: 1, origin: 'api' };
const program = { graphId: 'program-library', programIri: 'urn:program:1', programLayer: 'wm' as const, sourceHash: 'a'.repeat(64), authorAgentAddress: wallet.address };
const approvalInput = { ...operation, program, allowedCallers: [wallet.address], assetCreation: { toolIri: 'urn:tool:create' } };
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
});

function client(fetch: typeof globalThis.fetch, options: Partial<GraphComputerOptions> = {}) {
  return new GraphComputer({ nodeUrl: 'http://node.test', peerId, signer, retryDelayMs: 0, fetch, ...options });
}

function verifyHttp(url: URL, init: RequestInit) {
  const h = new Headers(init.headers);
  const message = agentHttpSigningMessage({
    agentAddress: h.get('x-dkg-agent-address')!, targetPeerId: h.get('x-dkg-agent-target')!,
    method: init.method!, path: url.pathname + url.search, contentType: h.get('content-type') ?? '',
    body: Buffer.from(init.body as string ?? ''), timestamp: h.get('x-dkg-agent-timestamp')!, nonce: h.get('x-dkg-agent-nonce')!,
  });
  expect(verifyMessage(message, h.get('authorization')!.slice('DKG-Agent '.length))).toBe(wallet.address);
  expect(init.redirect).toBe('error');
  expect(init.credentials).toBe('omit');
  return h;
}

describe('Program client', () => {
  it('calls the default browser fetch with the global receiver', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async function (this: unknown, _url, init) {
      expect(this).toBe(globalThis);
      return json(receipt(JSON.parse(String(init!.body)).invocationId));
    });
    const sdk = new GraphComputer({ nodeUrl: 'http://node.test', peerId, signer, retries: 0 });
    await sdk.programs.invoke(operation);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('loads source through an agent-signed request and verifies the returned graph scope', async () => {
    const source = 'export function run() { return 42; }';
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      verifyHttp(new URL(String(url)), init!);
      return json({ contextGraphId: program.graphId, programIri: program.programIri, layer: 'wm',
        source, version: '1', language: 'typescript-v1', authorAgentAddress: wallet.address,
        requiredTools: [], permittedPrograms: [] });
    });
    expect(await client(fetch).programs.getSource(program)).toMatchObject({ source, sourceHash: sha256(source) });
    await expect(client(fetch).programs.getSource({ ...program, graphId: 'other-graph' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('snapshots and signs canonical TypeScript inputs with the daemon v4 scope', async () => {
    const inputs = [{ z: 2, a: [1, 'é'] }];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      expect(body.inputs).toEqual([{ a: [1, 'é'], z: 2 }]);
      verifyAgentDelegation(body.authorization, { expectedScope: boundSemanticInvocationScope({
        version: 4, kind: 'bound-operation', contextGraphId: operation.graphId, operationIri: operation.operationIri,
        invocationId: body.invocationId, inputs: body.inputs,
      }, executorPeerId) });
      return json(receipt(body.invocationId));
    });
    const c = client(fetch, { executorPeerId });
    const prepared = c.programs.prepareInvocation({ ...operation, inputs });
    inputs[0].z = 999;
    await c.programs.invoke(prepared);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects non-JSON and oversized arguments before signing', () => {
    const c = client(vi.fn());
    for (const inputs of [[NaN], [undefined], [new Date()], ['x'.repeat(65536)], [1n]]) {
      expect(() => c.programs.prepareInvocation({ ...operation, inputs } as any)).toThrow();
    }
  });

  it('uploads exact UTF-8 source and declarations into sealed WM with no implicit sharing or approval', async () => {
    const source = '(strategy example (version "1.0.0") (goal "é\\n device"))\n';
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      verifyHttp(new URL(String(url)), init!);
      const body = JSON.parse(init!.body as string);
      expect(String(url)).toBe('http://node.test/api/knowledge-assets');
      expect(body).toMatchObject({ contextGraphId: 'program-library', finalize: true, alsoShareSwm: false, alsoPublishVm: false });
      expect(JSON.parse(body.quads.find((q: any) => q.predicate.endsWith('#source')).object)).toBe(source);
      expect(body.quads.filter((q: any) => q.predicate.endsWith('#requiresTool'))).toHaveLength(1);
      expect(init!.body).not.toContain(wallet.privateKey);
      return json({ assertionUri: 'urn:asset:1', status: 'wm-sealed', authorAddress: wallet.address }, 201);
    });
    const uploaded = await client(fetch).programs.upload({ graphId: 'did:dkg:context-graph:program-library', source, requiredTools: ['urn:tool:read', 'urn:tool:read'] });
    expect(uploaded).toMatchObject({ sourceHash: sha256(source), authorAgentAddress: wallet.address, programLayer: 'wm', graphId: 'program-library' });
    expect(uploaded.programIri).toMatch(/^urn:dkg:program:/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['draft-open', 'swm-shared'])('does not call an upload successful on unexpected lifecycle state %s', async status => {
    const c = client(async () => json({ status, assertionUri: 'urn:asset:1', authorAddress: wallet.address }));
    await expect(c.programs.upload({ graphId: 'programs', source: '(program)', requiredTools: [] })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('constructs a pinned approval without granting access to the data graph or silently updating a conflict', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      verifyHttp(new URL(String(url)), init!);
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({ binding: {
        contextGraphId: operation.graphId, operationIri: operation.operationIri,
        allowedCallerAgentAddresses: [wallet.address], executorAgentAddress: wallet.address,
        executionLayer: 'wm', assetCreation: { toolIri: 'urn:tool:create' },
        program: { contextGraphId: program.graphId, programIri: program.programIri, programLayer: 'wm', sourceHash: program.sourceHash, authorAgentAddress: wallet.address },
      } });
      return json({ code: 'PROGRAM_CONFIGURATION_CONFLICT', error: 'Inspect the revision' }, 409);
    });
    await expect(client(fetch).programs.approve(approvalInput)).rejects.toMatchObject({ status: 409, code: 'PROGRAM_CONFIGURATION_CONFLICT' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('signs exact encoded GET paths and sends explicit revisions for updates/revocations', async () => {
    const calls: Array<{ method: string; path: string; body: any }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const u = new URL(String(url)); verifyHttp(u, init!);
      calls.push({ method: init!.method!, path: u.pathname + u.search, body: init!.body ? JSON.parse(init!.body as string) : undefined });
      const binding = { ...entry, binding: {}, bindingDigest: 'a'.repeat(64) };
      const route = { ...entry, route: init!.method === 'DELETE' ? null : { contextGraphId: operation.graphId, operationIri: operation.operationIri, targetPeerId: executorPeerId } };
      const value = u.pathname.endsWith('bindings') ? binding : route;
      return json(init!.method === 'GET' && !u.searchParams.has('operationIri') ? [value] : value);
    });
    const c = client(fetch);
    await c.programs.getApproval(operation);
    await c.programs.listApprovals({ graphId: operation.graphId });
    await c.programs.updateApproval({ ...approvalInput, expectedRevision: 1 });
    await c.programs.revoke({ ...operation, expectedRevision: 2 });
    await c.routes.create({ ...operation, targetPeerId: executorPeerId });
    await c.routes.get(operation);
    await c.routes.list({ graphId: operation.graphId });
    await c.routes.update({ ...operation, targetPeerId: 'peer-new', expectedRevision: 1 });
    await c.routes.remove({ ...operation, expectedRevision: 2 });
    expect(calls[0].path).toBe('/api/programs/bindings?contextGraphId=private-data&operationIri=urn%3Aexample%3Aread-devices');
    expect(calls[2].body.expectedRevision).toBe(1);
    expect(calls[3].body).toEqual({ contextGraphId: operation.graphId, operationIri: operation.operationIri, expectedRevision: 2 });
    expect(calls[4].body.expectedRevision).toBeUndefined();
    expect(calls[7].body.expectedRevision).toBe(1);
    expect(calls[8].body.expectedRevision).toBe(2);
  });

  it('invokes locally without a forwarding proof and decodes outputs while retaining RDF terms', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      verifyHttp(new URL(String(url)), init!);
      const body = JSON.parse(init!.body as string);
      expect(Object.keys(body).sort()).toEqual(['contextGraphId', 'invocationId', 'operationIri']);
      return json(receipt(body.invocationId));
    });
    const result = await client(fetch).programs.invoke(operation);
    expect(result.outputs).toEqual([{ bindings: [{ device: 'urn:device:1', value: '"21.5"' }] }, 'plain text']);
    expect(result.rawOutputs).toHaveLength(2);
    expect(result.persisted).toBe(true);
  });

  it('refreshes both signatures on retry, binding the same UUID to the caller, forwarder, executor, graph and operation', async () => {
    const nonces: string[] = []; const authorizations: any[] = []; const bodies: any[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const h = verifyHttp(new URL(String(url)), init!); nonces.push(h.get('x-dkg-agent-nonce')!);
      const body = JSON.parse(init!.body as string); bodies.push(body); authorizations.push(body.authorization);
      const scope = 'dkg.semantic-runtime.bound-operation.v3:' + sha256(JSON.stringify([3, 'bound-operation', operation.graphId, operation.operationIri, body.invocationId, executorPeerId]));
      expect(verifyAgentDelegation(body.authorization, { expectedScope: scope })).toMatchObject({ agentAddress: wallet.address, delegateePeerId: peerId });
      expect(body.authorization.expiresAtMs - body.authorization.issuedAtMs).toBe(300_000);
      if (bodies.length === 1) return json({ code: 'PROGRAM_TARGET_NODE_UNREACHABLE', error: 'Temporary outage' }, 503);
      return json(receipt(body.invocationId));
    });
    const signMessage = vi.fn(signer.signMessage);
    const result = await client(fetch, { executorPeerId, signer: { ...signer, signMessage } }).programs.invoke({ ...operation, graphId: 'did:dkg:context-graph:private-data' });
    expect(new Set(nonces).size).toBe(2);
    expect(bodies[0].invocationId).toBe(result.invocationId);
    expect(bodies[1].invocationId).toBe(result.invocationId);
    expect(authorizations[0].scope).toBe(authorizations[1].scope);
    expect(signMessage).toHaveBeenCalledTimes(4);
  });

  it('preserves the recovery handle and does not retry authorization, conflict or reconciliation failures', async () => {
    for (const [status, code] of [[403, 'PROGRAM_INVOCATION_FORBIDDEN'], [409, 'INVOCATION_LAYER_CONFLICT'], [500, 'INVOCATION_REQUIRES_RECONCILIATION']] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ code, error: 'Review required' }, status));
      const c = client(fetch);
      const prepared = c.programs.prepareInvocation(operation);
      expect(fetch).not.toHaveBeenCalled();
      await expect(c.programs.invoke(JSON.parse(JSON.stringify(prepared)))).rejects.toMatchObject({ code, status, invocationId: prepared.invocationId });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it.each(['persisted', 'invocationId', 'executionIri', 'executionLayer', 'outputs'])('rejects inconsistent success field %s without inventing another execution', async field => {
    const id = randomUUID();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ ...receipt(id), [field]: false }));
    await expect(client(fetch).programs.invoke({ ...operation, invocationId: id })).rejects.toMatchObject({ code: 'INVALID_RESPONSE', invocationId: id });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never retries upload or configuration writes after an ambiguous network failure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new TypeError('socket closed'); });
    const c = client(fetch);
    await expect(c.programs.upload({ graphId: 'programs', source: '(source)', requiredTools: [] })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(c.routes.create({ ...operation, targetPeerId: executorPeerId })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('bounds retries and returns the generated invocation ID on exhausted network errors', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('offline'); });
    const error = await client(fetch).programs.invoke(operation).catch(e => e);
    expect(error).toBeInstanceOf(GraphComputerError);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.invocationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new Set(fetch.mock.calls.map(c => JSON.parse(c[1]!.body as string).invocationId)).size).toBe(1);
  });

  it('respects a long Retry-After by returning the rate limit instead of retrying early', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({}, 429, { 'retry-after': '60' }));
    await expect(client(fetch).programs.invoke(operation)).rejects.toMatchObject({ status: 429, code: 'HTTP_ERROR' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds response size and preserves the invocation ID', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('a'.repeat(1025)));
    await expect(client(fetch, { maxResponseBytes: 1024 }).programs.invoke(operation)).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE', invocationId: expect.any(String) });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('supports cancellation before sending and while waiting for retry', async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(client(fetch).programs.invoke(operation, { signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(fetch).not.toHaveBeenCalled();
    const retryAbort = new AbortController();
    const retryFetch = vi.fn<typeof globalThis.fetch>(async () => {
      setTimeout(() => retryAbort.abort(), 20);
      return json({}, 503);
    });
    await expect(client(retryFetch, { retryDelayMs: 1000 }).programs.invoke(operation, { signal: retryAbort.signal })).rejects.toMatchObject({ code: 'ABORTED', invocationId: expect.any(String) });
    expect(retryFetch).toHaveBeenCalledTimes(1);
  });

  it('times out stalled signing without sending or retrying wallet prompts', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const c = client(fetch, { timeoutMs: 20, signer: { getAddress: () => new Promise(() => {}), signMessage: signer.signMessage } });
    await expect(c.programs.invoke(operation)).rejects.toMatchObject({ code: 'TIMEOUT', invocationId: expect.any(String) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a signer returning another identity before sending anything', async () => {
    const other = Wallet.createRandom(); const fetch = vi.fn<typeof globalThis.fetch>();
    const c = client(fetch, { signer: { getAddress: wallet.getAddress.bind(wallet), signMessage: other.signMessage.bind(other) } });
    await expect(c.programs.invoke(operation)).rejects.toMatchObject({ code: 'SIGNING_FAILED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects arbitrary invocation input and unsafe graph/IRI fields before a request', () => {
    const fetch = vi.fn<typeof globalThis.fetch>(); const c = client(fetch);
    expect(() => c.programs.prepareInvocation({ ...operation, input: { deviceId: 1 } } as any)).toThrow('Unsupported invocation field');
    expect(() => c.programs.prepareInvocation({ ...operation, graphId: 'tenant/../other' })).toThrow('Context Graph');
    expect(() => c.programs.prepareInvocation({ ...operation, operationIri: 'urn:test> INSERT' })).toThrow('IRI');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('recovers a dropped HTTP response without repeating the side effect', async () => {
    const executions = new Map<string, ReturnType<typeof receipt>>();
    const nonces = new Set<string>(); let requests = 0; let effects = 0;
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        verifyHttp(new URL(req.url!, 'http://fixture'), { method: req.method, headers: req.headers as Record<string, string>, body, redirect: 'error', credentials: 'omit' });
        expect(nonces.has(req.headers['x-dkg-agent-nonce'] as string)).toBe(false);
        nonces.add(req.headers['x-dkg-agent-nonce'] as string);
        requests++;
        const input = JSON.parse(body);
        if (!executions.has(input.invocationId)) { effects++; executions.set(input.invocationId, receipt(input.invocationId)); }
        if (requests === 1) { req.socket.destroy(); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(executions.get(input.invocationId)));
      } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const c = new GraphComputer({ nodeUrl: `http://127.0.0.1:${port}`, peerId, signer, retryDelayMs: 0 });
    const result = await c.programs.invoke(operation);
    expect(result.persisted).toBe(true);
    expect(requests).toBe(2); expect(effects).toBe(1); expect(nonces.size).toBe(2);
  });
});
