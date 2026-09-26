import { describe, expect, it } from 'vitest';
import { Agent } from 'undici';
import {
  bundledUndiciMajor,
  rpcFetchDispatcher,
  rpcFetchTransportInit,
} from '../src/rpc-http1-dispatcher.js';

describe('chain RPC HTTP/1.1 dispatcher (#2828)', () => {
  it('reads the bundled undici major version', () => {
    expect(bundledUndiciMajor('6.28.0')).toBe(6);
    expect(bundledUndiciMajor('7.12.0')).toBe(7);
    expect(bundledUndiciMajor('8.0.2')).toBe(8);
    expect(bundledUndiciMajor('10.1')).toBe(10);
    // undefined means "this Node", like the default argument.
    expect(bundledUndiciMajor(undefined)).toBe(bundledUndiciMajor(process.versions.undici));
    expect(bundledUndiciMajor('')).toBeNull();
    expect(bundledUndiciMajor('x.1.0')).toBeNull();
  });

  it('keeps the default dispatcher where the bundled undici stays on HTTP/1.1 (Node 22 and 24)', () => {
    expect(rpcFetchDispatcher('6.28.0')).toBeUndefined();
    expect(rpcFetchDispatcher('7.12.0')).toBeUndefined();
    expect(rpcFetchDispatcher('not-a-version')).toBeUndefined();
    expect(rpcFetchTransportInit('6.28.0')).toEqual({});
  });

  it('uses one HTTP/1.1-only undici 7 Agent where the bundled undici negotiates HTTP/2 (Node 26)', () => {
    const first = rpcFetchDispatcher('8.0.2');
    expect(first).toBeInstanceOf(Agent);
    expect(rpcFetchDispatcher('8.11.0')).toBe(first);
    expect(rpcFetchTransportInit('9.0.0')).toEqual({ dispatcher: first });
  });

  it('follows the running Node when no version is given', () => {
    const major = bundledUndiciMajor(process.versions.undici);
    const init = rpcFetchTransportInit();
    if (major !== null && major >= 8) expect(init.dispatcher).toBeInstanceOf(Agent);
    else expect(init).toEqual({});
  });
});
