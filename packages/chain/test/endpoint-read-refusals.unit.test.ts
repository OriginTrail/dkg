// SPDX-License-Identifier: Apache-2.0

/**
 * A read that an endpoint refuses by policy stops starting at that endpoint.
 *
 * The first block is the memory on its own. The second is the failover client
 * over three endpoints, with the case this exists for: an endpoint that serves
 * contract calls and answers every receipt lookup with HTTP 403.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  ENDPOINT_READ_REFUSAL_TTL_MS,
  EndpointReadRefusals,
  isEndpointPolicyRefusal,
} from '../src/endpoint-read-refusals.js';
import { _resetRpcFailoverStatsForTest } from '../src/rpc-failover-log.js';
import { makeClient, NEVER_SIGN, recorder, retryable429 } from './rpc-failover-test-helpers.js';

const PRIMARY = 'https://primary.example';
const REFUSER = 'https://refuser.example';
const THIRD = 'https://third.example';
const URLS = [PRIMARY, REFUSER, THIRD];

const attemptsFor = (...urls: string[]) => urls.map((rpcUrl) => ({ endpoint: { rpcUrl } }));
const urlsOf = (attempts: Array<{ endpoint: { rpcUrl: string } }>) => attempts.map(({ endpoint }) => endpoint.rpcUrl);

/** What the transport raises for an HTTP error response, as ethers shapes it. */
function httpError(status: number, statusText: string): Error {
  return Object.assign(new Error(`server response ${status} ${statusText}`), {
    code: 'SERVER_ERROR',
    info: { responseStatus: `${status} ${statusText}` },
    response: { statusCode: status },
  });
}
const refused403 = () => httpError(403, 'Forbidden');

afterEach(() => { _resetRpcFailoverStatsForTest(); });

describe('isEndpointPolicyRefusal', () => {
  it.each([401, 403])('is true for HTTP %i', (status) => {
    expect(isEndpointPolicyRefusal(httpError(status, 'refused'))).toBe(true);
  });

  it('finds the status where a wrapper carries it', () => {
    expect(isEndpointPolicyRefusal(new Error('read failed', { cause: refused403() }))).toBe(true);
    expect(isEndpointPolicyRefusal(Object.assign(new Error('refused'), { status: '403' }))).toBe(true);
  });

  it.each([
    ['a throttle', retryable429()],
    ['a server error', httpError(503, 'Service Unavailable')],
    ['a network failure', Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })],
    ['an error without a status', new Error('could not decode result data')],
    ['nothing', undefined],
  ])('is false for %s', (_name, error) => {
    expect(isEndpointPolicyRefusal(error)).toBe(false);
  });
});

describe('EndpointReadRefusals', () => {
  it('leaves the order alone until an endpoint has refused that read', () => {
    const refusals = new EndpointReadRefusals({ now: () => 0 });
    const attempts = attemptsFor(REFUSER, PRIMARY, THIRD);

    expect(refusals.order('receipt lookup', attempts)).toBe(attempts);
  });

  it('moves the endpoint that refused a read behind the others, for that read only', () => {
    const refusals = new EndpointReadRefusals({ now: () => 0 });
    refusals.record('receipt lookup', REFUSER);

    const attempts = attemptsFor(REFUSER, PRIMARY, THIRD);
    const ordered = refusals.order('receipt lookup', attempts);

    expect(urlsOf(ordered)).toEqual([PRIMARY, THIRD, REFUSER]);
    // The same entries, so whatever each carries stays with its endpoint.
    expect(ordered[2]).toBe(attempts[0]);
    expect(refusals.order('kas.getLatestMerkleRoot', attempts)).toBe(attempts);
  });

  it('keeps the relative order of the endpoints on each side', () => {
    const refusals = new EndpointReadRefusals({ now: () => 0 });
    refusals.record('receipt lookup', PRIMARY);
    refusals.record('receipt lookup', THIRD);

    expect(urlsOf(refusals.order('receipt lookup', attemptsFor(THIRD, REFUSER, PRIMARY))))
      .toEqual([REFUSER, THIRD, PRIMARY]);
  });

  it('changes nothing when every endpoint has refused the read', () => {
    const refusals = new EndpointReadRefusals({ now: () => 0 });
    for (const url of URLS) refusals.record('receipt lookup', url);
    const attempts = attemptsFor(REFUSER, PRIMARY, THIRD);

    expect(refusals.order('receipt lookup', attempts)).toBe(attempts);
  });

  it('forgets a refusal after its time, and a new refusal renews it', () => {
    let clock = 1_000;
    const refusals = new EndpointReadRefusals({ now: () => clock });
    const attempts = attemptsFor(REFUSER, PRIMARY);
    refusals.record('receipt lookup', REFUSER);

    clock += ENDPOINT_READ_REFUSAL_TTL_MS - 1;
    expect(urlsOf(refusals.order('receipt lookup', attempts))).toEqual([PRIMARY, REFUSER]);
    clock += 1;
    expect(refusals.order('receipt lookup', attempts)).toBe(attempts);

    refusals.record('receipt lookup', REFUSER);
    clock += ENDPOINT_READ_REFUSAL_TTL_MS - 1;
    expect(urlsOf(refusals.order('receipt lookup', attempts))).toEqual([PRIMARY, REFUSER]);
  });

  it('keeps a bounded number of refusals, the most recently seen ones', () => {
    const refusals = new EndpointReadRefusals({ now: () => 0, maxEntries: 2 });
    refusals.record('read a', REFUSER);
    refusals.record('read b', REFUSER);
    refusals.record('read a', REFUSER);
    refusals.record('read c', REFUSER);
    const attempts = attemptsFor(REFUSER, PRIMARY);

    expect(refusals.order('read b', attempts)).toBe(attempts);
    expect(urlsOf(refusals.order('read a', attempts))).toEqual([PRIMARY, REFUSER]);
    expect(urlsOf(refusals.order('read c', attempts))).toEqual([PRIMARY, REFUSER]);
  });
});

describe('RpcFailoverClient with an endpoint that refuses receipt lookups', () => {
  const receipt = { status: 1, hash: '0xhash' };

  /**
   * Three endpoints. The primary throttles contract calls while `primaryThrottles`
   * is set, so the preference moves to the second one, which serves calls and
   * refuses every receipt lookup.
   */
  function endpoints() {
    const state = { primaryThrottles: true };
    const primary = {
      call: recorder(async () => {
        if (state.primaryThrottles) throw retryable429();
        return 'primary';
      }),
      getTransactionReceipt: recorder(async () => receipt),
    };
    const refuser = {
      call: recorder(async () => 'refuser'),
      getTransactionReceipt: recorder(async (): Promise<typeof receipt> => { throw refused403(); }),
    };
    const third = {
      call: recorder(async () => 'third'),
      getTransactionReceipt: recorder(async () => receipt),
    };
    return { state, primary, refuser, third };
  }
  const call = (client: ReturnType<typeof makeClient>) => client.read('kas.someView', (p: any) => p.call());

  it('sends a receipt lookup to the refusing endpoint once, then starts at the others', async () => {
    const { primary, refuser, third } = endpoints();
    let clock = 0;
    const client = makeClient([primary, refuser, third], URLS, NEVER_SIGN, { enabled: true, now: () => clock });

    await expect(call(client)).resolves.toBe('refuser'); // the preference moves to the refuser
    await expect(client.getReceipt('0xhash')).resolves.toBe(receipt);
    expect(refuser.getTransactionReceipt.calls).toHaveLength(1);
    expect(primary.getTransactionReceipt.calls).toHaveLength(1);

    // The same again: the preference returns to the refuser, the receipt does not.
    for (let i = 0; i < 5; i += 1) {
      clock += 1_000;
      await expect(call(client)).resolves.toBe('refuser');
      await expect(client.getReceipt('0xhash')).resolves.toBe(receipt);
    }
    expect(refuser.getTransactionReceipt.calls).toHaveLength(1);
    expect(primary.getTransactionReceipt.calls).toHaveLength(6);
    expect(third.getTransactionReceipt.calls).toHaveLength(0);
  });

  it('leaves the preference for other reads where it was', async () => {
    const { primary, refuser } = endpoints();
    let clock = 0;
    const client = makeClient([primary, refuser], URLS.slice(0, 2), NEVER_SIGN, { enabled: true, now: () => clock });

    await call(client);              // primary throttles, the refuser serves: preferred
    await client.getReceipt('0xhash'); // refused once: this clears the preference, as before
    await call(client);              // primary throttles again: preferred again
    expect(primary.call.calls).toHaveLength(2);

    // From here the receipt is served by the primary without touching the
    // preference: calls keep starting at the refuser, which serves them.
    for (let i = 0; i < 5; i += 1) {
      clock += 1_000;
      await client.getReceipt('0xhash');
      await expect(call(client)).resolves.toBe('refuser');
    }
    expect(primary.call.calls).toHaveLength(2);
    expect(refuser.getTransactionReceipt.calls).toHaveLength(1);
  });

  it('still reaches the refusing endpoint when no other endpoint answers', async () => {
    const { primary, refuser } = endpoints();
    const client = makeClient([primary, refuser], URLS.slice(0, 2), NEVER_SIGN, { enabled: true });
    await call(client);
    await client.getReceipt('0xhash');
    primary.getTransactionReceipt = recorder(async (): Promise<typeof receipt> => { throw retryable429(); });

    await expect(client.getReceipt('0xhash')).rejects.toMatchObject({ code: 'RPC_RECEIPT_LOOKUP_FAILED' });
    expect(primary.getTransactionReceipt.calls).toHaveLength(1);
    expect(refuser.getTransactionReceipt.calls).toHaveLength(2);
  });

  it('remembers the refusal per read: another read still starts at that endpoint', async () => {
    const { primary, refuser } = endpoints();
    const client = makeClient([primary, refuser], URLS.slice(0, 2), NEVER_SIGN, { enabled: true });
    await call(client);
    await client.getReceipt('0xhash');
    await call(client);

    await expect(client.read('kas.otherView', (p: any) => p.call())).resolves.toBe('refuser');
    expect(primary.call.calls).toHaveLength(2);
  });

  it('tries the endpoint again after the refusal has lapsed', async () => {
    const { primary, refuser } = endpoints();
    let clock = 0;
    const client = makeClient([primary, refuser], URLS.slice(0, 2), NEVER_SIGN, { enabled: true, now: () => clock });
    await call(client);
    await client.getReceipt('0xhash');
    await call(client);

    clock += ENDPOINT_READ_REFUSAL_TTL_MS;
    await call(client);
    await client.getReceipt('0xhash');

    expect(refuser.getTransactionReceipt.calls).toHaveLength(2);
  });

  it('does not treat a throttle as a refusal', async () => {
    const { state, primary, refuser } = endpoints();
    refuser.getTransactionReceipt = recorder(async (): Promise<typeof receipt> => { throw retryable429(); });
    const client = makeClient([primary, refuser], URLS.slice(0, 2), NEVER_SIGN, { enabled: true });

    for (let i = 0; i < 3; i += 1) {
      state.primaryThrottles = true;
      await call(client);              // preferred: the second endpoint
      await client.getReceipt('0xhash'); // throttled there, served by the primary
    }

    expect(refuser.getTransactionReceipt.calls).toHaveLength(3);
  });

  it('keeps the configured order for a tip-sensitive read', async () => {
    const primary = { head: recorder(async (): Promise<number> => { throw refused403(); }) };
    const backup = { head: recorder(async () => 7) };
    const client = makeClient([primary, backup], URLS.slice(0, 2), NEVER_SIGN, { enabled: true });
    const head = () => client.read('chain head', (p: any) => p.head(), { skipPreferred: true });

    await expect(head()).resolves.toBe(7);
    await expect(head()).resolves.toBe(7);

    expect(primary.head.calls).toHaveLength(2);
  });

  it('keeps the configured order for every read when endpoint ordering is switched off', async () => {
    const primary = { getTransactionReceipt: recorder(async (): Promise<typeof receipt> => { throw refused403(); }) };
    const backup = { getTransactionReceipt: recorder(async () => receipt) };
    const client = makeClient([primary, backup], URLS.slice(0, 2), NEVER_SIGN, { enabled: false });

    await client.getReceipt('0xhash');
    await client.getReceipt('0xhash');

    expect(primary.getTransactionReceipt.calls).toHaveLength(2);
  });

  it('does not spend the primary re-probe on a read the primary refuses', async () => {
    let clock = 0;
    const primary = {
      view: recorder(async (): Promise<string> => { throw refused403(); }),
      other: recorder(async () => 'primary'),
    };
    const backup = { view: recorder(async () => 'backup'), other: recorder(async () => 'backup') };
    const client = makeClient(
      [primary, backup], URLS.slice(0, 2), NEVER_SIGN, { enabled: true, ttlMs: 30_000, now: () => clock },
    );
    const view = () => client.read('kas.refusedView', (p: any) => p.view());

    await expect(view()).resolves.toBe('backup'); // refused by the primary: the backup is preferred
    clock = 35_000;                               // past the time the primary is tried again
    await expect(view()).resolves.toBe('backup');
    expect(primary.view.calls).toHaveLength(1);

    // A read the primary serves still finds it again, and clears the preference.
    clock = 70_000;
    await expect(client.read('kas.otherView', (p: any) => p.other())).resolves.toBe('primary');
    await expect(client.read('kas.otherView', (p: any) => p.other())).resolves.toBe('primary');
    expect(backup.other.calls).toHaveLength(0);
  });
});
