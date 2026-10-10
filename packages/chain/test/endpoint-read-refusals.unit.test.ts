// SPDX-License-Identifier: Apache-2.0

/**
 * A read that an endpoint refuses by policy stops starting at that endpoint.
 *
 * The first two blocks cover refusal classification and the ordering owner
 * applying the memory before binding ordinary/substitute outcomes. The third is the failover client
 * over real stickiness, with the case this exists for: an endpoint that serves
 * contract calls and answers every receipt lookup with HTTP 403.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ENDPOINT_READ_REFUSAL_TTL_MS,
  EndpointReadRefusals,
  isEndpointPolicyRefusal,
} from '../src/endpoint-read-refusals.js';
import { EndpointStickiness } from '../src/endpoint-stickiness.js';
import type { SignPopulatedFn } from '../src/rpc-failover-client.js';
import { _resetRpcFailoverStatsForTest } from '../src/rpc-failover-log.js';
import { makeClient, NEVER_SIGN, recorder, retryable429 } from './rpc-failover-test-helpers.js';

const PRIMARY = 'https://primary.example';
const REFUSER = 'https://refuser.example';
const THIRD = 'https://third.example';
const URLS = [PRIMARY, REFUSER, THIRD];
const LABEL = 'receipt lookup';

/** What the transport raises for an HTTP error response, as ethers shapes it. */
function httpError(status: number, statusText: string): Error {
  return Object.assign(new Error(`server response ${status} ${statusText}`), {
    code: 'SERVER_ERROR',
    info: { responseStatus: `${status} ${statusText}` },
    response: { statusCode: status },
  });
}
const refused403 = () => httpError(403, 'Forbidden');

/** Observe stickiness transitions after the ordering owner binds the complete plan. */
function stickyOrder(...urls: string[]) {
  const log: string[] = [];
  const owner = new EndpointStickiness({ now: () => 0, ttlMs: 30_000, isEnabled: () => true });
  vi.spyOn(owner as any, 'recordSuccess').mockImplementation((endpoint: any) => { log.push(`success ${endpoint.rpcUrl}`); });
  vi.spyOn(owner as any, 'recordFailure').mockImplementation((endpoint: any) => { log.push(`failure ${endpoint.rpcUrl}`); });
  return { endpoints: urls.map(rpcUrl => ({ rpcUrl })), owner, log };
}
function readAttempts(memory: EndpointReadRefusals, label: string, order: ReturnType<typeof stickyOrder>, remember = true) {
  return order.owner.readAttempts(order.endpoints, 'stickyRead', { label, memory, remember });
}
const urlsOf = (attempts: Array<{ endpoint: { rpcUrl: string } }>) => attempts.map(({ endpoint }) => endpoint.rpcUrl);

/** Run one pass: fail the endpoints in `failing` (with their error), be served by the first other one. */
function runPass(
  refusals: EndpointReadRefusals,
  label: string,
  order: ReturnType<typeof stickyOrder>,
  failing: Record<string, Error> = {},
): { tried: string[]; servedBy: string | undefined } {
  const tried: string[] = [];
  for (const attempt of readAttempts(refusals, label, order)) {
    tried.push(attempt.endpoint.rpcUrl);
    const error = failing[attempt.endpoint.rpcUrl];
    if (error === undefined) {
      attempt.recordSuccess();
      return { tried, servedBy: attempt.endpoint.rpcUrl };
    }
    attempt.recordFailure(error);
  }
  return { tried, servedBy: undefined };
}

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

describe('EndpointStickiness complete refusal-aware plan', () => {
  it('is the stickiness order and its recorders until an endpoint has refused the read', () => {
    const refusals = new EndpointReadRefusals({ now: () => 0 });
    const order = stickyOrder(REFUSER, PRIMARY, THIRD);

    const pass = runPass(refusals, LABEL, order, { [REFUSER]: retryable429() });

    expect(pass).toEqual({ tried: [REFUSER, PRIMARY], servedBy: PRIMARY });
    expect(order.log).toEqual([`failure ${REFUSER}`, `success ${PRIMARY}`]);
    // A throttle is not remembered: the next pass starts at the same endpoint.
    expect(urlsOf(readAttempts(refusals, LABEL, stickyOrder(REFUSER, PRIMARY, THIRD))))
      .toEqual([REFUSER, PRIMARY, THIRD]);
  });

  it('records the refusal as the failure it always was, and remembers it for that read only', () => {
    const refusals = new EndpointReadRefusals({ now: () => 0 });
    const order = stickyOrder(REFUSER, PRIMARY, THIRD);

    runPass(refusals, LABEL, order, { [REFUSER]: refused403() });

    expect(order.log).toEqual([`failure ${REFUSER}`, `success ${PRIMARY}`]);
    expect(urlsOf(readAttempts(refusals, LABEL, stickyOrder(REFUSER, PRIMARY, THIRD))))
      .toEqual([PRIMARY, THIRD, REFUSER]);
    expect(urlsOf(readAttempts(refusals, 'kas.getLatestMerkleRoot', stickyOrder(REFUSER, PRIMARY, THIRD))))
      .toEqual([REFUSER, PRIMARY, THIRD]);
  });

  describe('when the endpoint stickiness starts at has refused the read', () => {
    function refusedByTheFirst() {
      const refusals = new EndpointReadRefusals({ now: () => 0 });
      runPass(refusals, LABEL, stickyOrder(REFUSER, PRIMARY, THIRD), { [REFUSER]: refused403() });
      return refusals;
    }

    it('goes to the others and tells stickiness nothing', () => {
      const refusals = refusedByTheFirst();
      const order = stickyOrder(REFUSER, PRIMARY, THIRD);

      const pass = runPass(refusals, LABEL, order);

      expect(pass).toEqual({ tried: [PRIMARY], servedBy: PRIMARY });
      expect(order.log).toEqual([]);
    });

    it('tells stickiness nothing about the others failing either', () => {
      const refusals = refusedByTheFirst();
      const order = stickyOrder(REFUSER, PRIMARY, THIRD);

      const pass = runPass(refusals, LABEL, order, { [PRIMARY]: retryable429() });

      expect(pass).toEqual({ tried: [PRIMARY, THIRD], servedBy: THIRD });
      expect(order.log).toEqual([]);
    });

    it('starts the next pass at the endpoint that served it instead', () => {
      const refusals = refusedByTheFirst();
      runPass(refusals, LABEL, stickyOrder(REFUSER, PRIMARY, THIRD), { [PRIMARY]: retryable429() });

      expect(runPass(refusals, LABEL, stickyOrder(REFUSER, PRIMARY, THIRD)))
        .toEqual({ tried: [THIRD], servedBy: THIRD });
    });

    it('drops that endpoint again when it fails, and goes on in the stickiness order', () => {
      const refusals = refusedByTheFirst();
      runPass(refusals, LABEL, stickyOrder(REFUSER, PRIMARY, THIRD), { [PRIMARY]: retryable429() });

      expect(runPass(refusals, LABEL, stickyOrder(REFUSER, PRIMARY, THIRD), { [THIRD]: retryable429() }))
        .toEqual({ tried: [THIRD, PRIMARY], servedBy: PRIMARY });
      expect(runPass(refusals, LABEL, stickyOrder(REFUSER, PRIMARY, THIRD)))
        .toEqual({ tried: [PRIMARY], servedBy: PRIMARY });
    });

    it('asks the refusing endpoint last, and records it as stickiness would', () => {
      const refusals = refusedByTheFirst();
      const order = stickyOrder(REFUSER, PRIMARY, THIRD);

      const pass = runPass(refusals, LABEL, order, {
        [PRIMARY]: retryable429(), [THIRD]: retryable429(), [REFUSER]: refused403(),
      });

      expect(pass).toEqual({ tried: [PRIMARY, THIRD, REFUSER], servedBy: undefined });
      expect(order.log).toEqual([`failure ${REFUSER}`]);
    });

    it('forgets the refusal when that endpoint serves the read after all', () => {
      const refusals = refusedByTheFirst();
      const order = stickyOrder(REFUSER, PRIMARY, THIRD);

      runPass(refusals, LABEL, order, { [PRIMARY]: retryable429(), [THIRD]: retryable429() });

      expect(order.log).toEqual([`success ${REFUSER}`]);
      expect(urlsOf(readAttempts(refusals, LABEL, stickyOrder(REFUSER, PRIMARY, THIRD))))
        .toEqual([REFUSER, PRIMARY, THIRD]);
    });

    it('remembers another endpoint that refuses the read while it is being tried instead', () => {
      const refusals = refusedByTheFirst();
      runPass(refusals, LABEL, stickyOrder(REFUSER, PRIMARY, THIRD), { [PRIMARY]: refused403() });

      expect(urlsOf(readAttempts(refusals, LABEL, stickyOrder(REFUSER, PRIMARY, THIRD))))
        .toEqual([THIRD, REFUSER, PRIMARY]);
    });
  });

  it('moves a refusing endpoint further down last and keeps every recorder as bound', () => {
    const refusals = new EndpointReadRefusals({ now: () => 0 });
    runPass(refusals, LABEL, stickyOrder(PRIMARY, REFUSER, THIRD), {
      [PRIMARY]: retryable429(), [REFUSER]: refused403(),
    });
    const order = stickyOrder(PRIMARY, REFUSER, THIRD);

    const pass = runPass(refusals, LABEL, order, { [PRIMARY]: retryable429() });

    // The endpoint stickiness starts at was tried first, so what follows means what it meant.
    expect(pass).toEqual({ tried: [PRIMARY, THIRD], servedBy: THIRD });
    expect(order.log).toEqual([`failure ${PRIMARY}`, `success ${THIRD}`]);
  });

  it('changes nothing when every endpoint has refused the read', () => {
    const refusals = new EndpointReadRefusals({ now: () => 0 });
    const everyoneRefuses = { [REFUSER]: refused403(), [PRIMARY]: refused403(), [THIRD]: refused403() };
    runPass(refusals, LABEL, stickyOrder(REFUSER, PRIMARY, THIRD), everyoneRefuses);
    const order = stickyOrder(REFUSER, PRIMARY, THIRD);

    const pass = runPass(refusals, LABEL, order, everyoneRefuses);

    expect(pass.tried).toEqual([REFUSER, PRIMARY, THIRD]);
    expect(order.log).toEqual([`failure ${REFUSER}`, `failure ${PRIMARY}`, `failure ${THIRD}`]);
  });

  it('forgets a refusal after its time, and a new refusal renews it', () => {
    let clock = 1_000;
    const refusals = new EndpointReadRefusals({ now: () => clock });
    const next = () => urlsOf(readAttempts(refusals, LABEL, stickyOrder(REFUSER, PRIMARY)));
    runPass(refusals, LABEL, stickyOrder(REFUSER, PRIMARY), { [REFUSER]: refused403() });

    clock += ENDPOINT_READ_REFUSAL_TTL_MS - 1;
    expect(next()).toEqual([PRIMARY, REFUSER]);
    clock += 1;
    expect(next()).toEqual([REFUSER, PRIMARY]);

    runPass(refusals, LABEL, stickyOrder(REFUSER, PRIMARY), { [REFUSER]: refused403() });
    clock += ENDPOINT_READ_REFUSAL_TTL_MS - 1;
    expect(next()).toEqual([PRIMARY, REFUSER]);
  });

  it('keeps a bounded number of refusals, the most recently seen ones', () => {
    const refusals = new EndpointReadRefusals({ now: () => 0, maxEntries: 2 });
    for (const label of ['read a', 'read b', 'read a', 'read c']) {
      runPass(refusals, label, stickyOrder(PRIMARY, REFUSER), { [PRIMARY]: retryable429(), [REFUSER]: refused403() });
    }
    const next = (label: string) => urlsOf(readAttempts(refusals, label, stickyOrder(PRIMARY, REFUSER, THIRD)));

    expect(next('read b')).toEqual([PRIMARY, REFUSER, THIRD]);
    expect(next('read a')).toEqual([PRIMARY, THIRD, REFUSER]);
    expect(next('read c')).toEqual([PRIMARY, THIRD, REFUSER]);
  });

  it('is the stickiness order with nothing remembered when told not to remember', () => {
    const refusals = new EndpointReadRefusals({ now: () => 0 });
    const order = stickyOrder(REFUSER, PRIMARY);
    const [first, second] = readAttempts(refusals, LABEL, order, false);

    first!.recordFailure(refused403());
    second!.recordSuccess();

    expect(order.log).toEqual([`failure ${REFUSER}`, `success ${PRIMARY}`]);
    expect(urlsOf(readAttempts(refusals, LABEL, stickyOrder(REFUSER, PRIMARY)))).toEqual([REFUSER, PRIMARY]);
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

  /**
   * The refuser has refused one receipt lookup and is preferred again, and the
   * primary now fails receipt lookups as well, so they are served by the third.
   */
  async function refuserPreferredAndPrimaryFailingReceipts() {
    const { primary, refuser, third } = endpoints();
    const client = makeClient([primary, refuser, third], URLS, NEVER_SIGN, { enabled: true });
    await call(client);
    await client.getReceipt('0xhash'); // refused by the refuser, served by the primary
    await call(client);              // the preference is on the refuser again
    primary.getTransactionReceipt = recorder(async (): Promise<typeof receipt> => { throw retryable429(); });
    return { client, primary, refuser, third };
  }

  it('does not move the preference to an endpoint that served the receipt instead', async () => {
    const { client, third } = await refuserPreferredAndPrimaryFailingReceipts();

    await expect(client.getReceipt('0xhash')).resolves.toBe(receipt);
    expect(third.getTransactionReceipt.calls).toHaveLength(1);

    // Calls still start at the refuser, not at the endpoint the receipt came from.
    await expect(call(client)).resolves.toBe('refuser');
    expect(third.call.calls).toHaveLength(0);
  });

  it('does not stall on a failing endpoint again once another has served the receipt', async () => {
    const { client, primary, refuser, third } = await refuserPreferredAndPrimaryFailingReceipts();

    for (let i = 0; i < 5; i += 1) await expect(client.getReceipt('0xhash')).resolves.toBe(receipt);

    // One attempt at the failing primary, then every lookup starts at the third.
    expect(primary.getTransactionReceipt.calls).toHaveLength(1);
    expect(third.getTransactionReceipt.calls).toHaveLength(5);
    expect(refuser.getTransactionReceipt.calls).toHaveLength(1);
  });

  it('keeps a write-proven preference when the receipt is served by another endpoint', async () => {
    // The backup refused a receipt lookup earlier. It then accepts a write, so
    // it is the endpoint whose pending nonce is current. A receipt lookup that
    // goes to the primary because of the remembered refusal must not change
    // that: the next transaction is still prepared at the backup.
    const primary: any = { getTransactionReceipt: recorder(async () => receipt) };
    const backup: any = {
      getTransactionReceipt: recorder(async (): Promise<typeof receipt> => { throw refused403(); }),
    };
    const populatedAt: string[] = [];
    const makeSigner = () => ({
      address: `0x${'ab'.repeat(20)}`,
      connect: (p: unknown) => ({ address: `0x${'ab'.repeat(20)}`, boundTo: p }),
    }) as any;
    const contract = { connect: (s: any) => ({ doWrite: { populateTransaction: () => {
      const at = s.boundTo === primary ? 'primary' : 'backup';
      populatedAt.push(at);
      return at === 'primary' ? Promise.reject(retryable429()) : Promise.resolve({ to: '0xTO', data: '0x' });
    } } }) } as any;
    const signPopulated = recorder(async () => ({ signedTx: '0xS', txHash: '0xH' }));
    const client = makeClient(
      [primary, backup], URLS.slice(0, 2), signPopulated as SignPopulatedFn, { enabled: true },
    );

    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'); // write-proven: the backup
    await client.getReceipt('0xold');                                          // refused there once
    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w'); // write-proven again
    expect(populatedAt).toEqual(['primary', 'backup', 'primary', 'backup']);

    await expect(client.getReceipt('0xold')).resolves.toBe(receipt);
    expect(backup.getTransactionReceipt.calls).toHaveLength(1);

    populatedAt.length = 0;
    await client.populateAndSign(contract, 'doWrite', [], makeSigner(), 'w');
    expect(populatedAt).toEqual(['backup']);
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
    clock = 35_001;
    await expect(client.read('kas.otherView', (p: any) => p.other())).resolves.toBe('primary');
    await expect(client.read('kas.otherView', (p: any) => p.other())).resolves.toBe('primary');
    expect(backup.other.calls).toHaveLength(0);
  });
});
