import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchRequest } from 'ethers';

const transportCalls: Array<{ input: string; init: RequestInit }> = [];

vi.mock('../src/rpc-http1-dispatcher.js', () => ({
  chainRpcFetch: async (input: string | URL, init: RequestInit) => {
    transportCalls.push({ input: String(input), init });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
}));

const { cancellableRpcGetUrl } = await import('../src/rpc-request-transport.js');
const { postStrictFinalizedJsonRpcV1 } = await import('../src/strict-current-finalized-evm-rpc-client.js');

function forbidGlobalFetch(): void {
  vi.stubGlobal('fetch', () => {
    throw new Error('a chain RPC path called the global fetch');
  });
}

/** Files under `src`, outside `archive`, whose code calls `fetch(…)` or `globalThis.fetch(…)`. */
function sourcesCallingGlobalFetch(): string[] {
  const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));
  const files: string[] = [];
  const visitDirectory = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== 'archive') visitDirectory(join(directory, entry.name));
      } else if (entry.name.endsWith('.ts')) {
        files.push(join(directory, entry.name));
      }
    }
  };
  visitDirectory(sourceRoot);

  return files.filter((path) => {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    let calls = false;
    const visitNode = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        calls ||= (ts.isIdentifier(callee) && callee.text === 'fetch')
          || (ts.isPropertyAccessExpression(callee)
            && callee.name.text === 'fetch'
            && ts.isIdentifier(callee.expression)
            && callee.expression.text === 'globalThis');
      }
      ts.forEachChild(node, visitNode);
    };
    visitNode(source);
    return calls;
  }).map((path) => path.slice(sourceRoot.length + 1));
}

afterEach(() => {
  vi.unstubAllGlobals();
  transportCalls.length = 0;
});

describe('chain RPC calls go through chainRpcFetch (#2828)', () => {
  it('the ethers RPC transport does, on every request', async () => {
    forbidGlobalFetch();
    const request = new FetchRequest('https://rpc.example.invalid/');
    request.body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });

    const response = await cancellableRpcGetUrl(request);

    expect(response.statusCode).toBe(200);
    expect(transportCalls).toHaveLength(1);
    expect(transportCalls[0]).toMatchObject({ input: 'https://rpc.example.invalid/', init: { method: 'POST' } });
    expect(transportCalls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('the strict finalized RPC client does too', async () => {
    forbidGlobalFetch();

    await postStrictFinalizedJsonRpcV1(
      'https://rpc.example.invalid/',
      1,
      'eth_blockNumber',
      [],
      64 * 1024,
      new AbortController().signal,
    );

    expect(transportCalls).toHaveLength(1);
    expect(transportCalls[0]).toMatchObject({
      input: 'https://rpc.example.invalid/',
      init: { method: 'POST', redirect: 'error' },
    });
  });

  it('no other chain source calls the global fetch', () => {
    expect(sourcesCallingGlobalFetch()).toEqual(['rpc-http1-dispatcher.ts']);
  });
});
