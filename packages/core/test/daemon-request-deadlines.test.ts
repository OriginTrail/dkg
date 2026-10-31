import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DAEMON_LIST_READ_ROUTES,
  DAEMON_LIST_READ_TIMEOUT_MS,
  DAEMON_LONG_TIMEOUT_ENV,
  DAEMON_LONG_TIMEOUT_MS,
  DAEMON_READ_TIMEOUT_ENV,
  DAEMON_READ_TIMEOUT_MS,
  DAEMON_AUTHORITY_RETRY_DELAYS_MS,
  DAEMON_AUTHORITY_RETRY_MAX_DELAY_MS,
  DAEMON_AUTHORITY_UNAVAILABLE_CODE,
  DAEMON_READ_AUTHORITY_UNAVAILABLE_CODE,
  classifyDaemonRequestDeadline,
  daemonAuthorityRetryDelayMs,
  isRetryableDaemonAuthorityAnswer,
  parseDaemonRetryAfterMs,
  resolveDaemonRequestDeadlines,
} from '../src/daemon-request-deadlines.js';

const LIST = { method: 'GET', path: '/api/context-graph/list' } as const;
const READ = { method: 'GET', path: '/api/status' } as const;
const WRITE = { method: 'POST', path: '/api/context-graph/register' } as const;

describe('daemon request deadline classes', () => {
  it('gives the graph, sub-graph, PCA and publisher-job lists the list class', () => {
    expect([...DAEMON_LIST_READ_ROUTES]).toEqual([
      '/api/context-graph/list',
      '/api/sub-graph/list',
      '/api/pca',
      '/api/publisher/jobs',
    ]);
    for (const path of DAEMON_LIST_READ_ROUTES) {
      expect(classifyDaemonRequestDeadline({ method: 'GET', path })).toBe('list-read');
    }
  });

  it('ignores the query string but matches the path exactly', () => {
    expect(classifyDaemonRequestDeadline({
      method: 'GET',
      path: '/api/sub-graph/list?contextGraphId=cg-1',
    })).toBe('list-read');
    expect(classifyDaemonRequestDeadline({ method: 'GET', path: '/api/publisher/jobs?status=queued' }))
      .toBe('list-read');
    for (const path of ['/api/pca/1', '/api/context-graph/list/', '/api/context-graph', '/api/pcas']) {
      expect(classifyDaemonRequestDeadline({ method: 'GET', path })).toBe('read');
    }
  });

  it('gives every method but GET the long class, list routes included', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
      expect(classifyDaemonRequestDeadline({ method, path: '/api/pca' })).toBe('long');
      expect(classifyDaemonRequestDeadline({ method, path: '/api/status' })).toBe('long');
    }
  });
});

describe('resolved daemon request deadlines', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const deadlinesOf = (resolved: ReturnType<typeof resolveDaemonRequestDeadlines>) => [
    resolved.timeoutMsFor(LIST),
    resolved.timeoutMsFor(READ),
    resolved.timeoutMsFor(WRITE),
  ];

  it('defaults to 60 s for lists, 30 s for other reads and 240 s for the rest', () => {
    const resolved = resolveDaemonRequestDeadlines({}, {});
    expect([DAEMON_LIST_READ_TIMEOUT_MS, DAEMON_READ_TIMEOUT_MS, DAEMON_LONG_TIMEOUT_MS])
      .toEqual([60_000, 30_000, 240_000]);
    expect(resolved).toMatchObject({
      readTimeoutMs: 30_000,
      listReadTimeoutMs: 60_000,
      longTimeoutMs: 240_000,
    });
    expect(deadlinesOf(resolved)).toEqual([60_000, 30_000, 240_000]);
    expect(Object.isFrozen(resolved)).toBe(true);
    // Unset and empty are the same: no override.
    expect(deadlinesOf(resolveDaemonRequestDeadlines({}, {
      [DAEMON_READ_TIMEOUT_ENV]: '',
      [DAEMON_LONG_TIMEOUT_ENV]: '  ',
    }))).toEqual([60_000, 30_000, 240_000]);
  });

  it('takes the read and long deadlines from the environment', () => {
    expect([DAEMON_READ_TIMEOUT_ENV, DAEMON_LONG_TIMEOUT_ENV])
      .toEqual(['DKG_API_READ_TIMEOUT_MS', 'DKG_API_LONG_TIMEOUT_MS']);
    expect(deadlinesOf(resolveDaemonRequestDeadlines({}, {
      DKG_API_READ_TIMEOUT_MS: '45000',
      DKG_API_LONG_TIMEOUT_MS: ' 600000 ',
    }))).toEqual([60_000, 45_000, 600_000]);
  });

  it('reads process.env when no environment is passed', () => {
    vi.stubEnv('DKG_API_READ_TIMEOUT_MS', '45000');
    vi.stubEnv('DKG_API_LONG_TIMEOUT_MS', '600000');
    expect(deadlinesOf(resolveDaemonRequestDeadlines())).toEqual([60_000, 45_000, 600_000]);
  });

  it('never gives a list less than the read deadline, nor the rest less than either', () => {
    expect(deadlinesOf(resolveDaemonRequestDeadlines({}, {
      DKG_API_READ_TIMEOUT_MS: '90000',
      DKG_API_LONG_TIMEOUT_MS: '5000',
    }))).toEqual([90_000, 90_000, 90_000]);
    expect(deadlinesOf(resolveDaemonRequestDeadlines({ readTimeoutMs: 70_000, longTimeoutMs: 1 }, {})))
      .toEqual([70_000, 70_000, 70_000]);
  });

  it('lets explicit options win over the environment, one deadline at a time', () => {
    const env = { DKG_API_READ_TIMEOUT_MS: '45000', DKG_API_LONG_TIMEOUT_MS: '600000' };
    expect(deadlinesOf(resolveDaemonRequestDeadlines({ readTimeoutMs: 20, longTimeoutMs: 1_000 }, env)))
      .toEqual([60_000, 20, 1_000]);
    expect(deadlinesOf(resolveDaemonRequestDeadlines({ readTimeoutMs: 20 }, env)))
      .toEqual([60_000, 20, 600_000]);
    expect(deadlinesOf(resolveDaemonRequestDeadlines({ longTimeoutMs: 1_000 }, env)))
      .toEqual([60_000, 45_000, 45_000]);
  });

  it.each(['0', '-1', '1.5', '30s', '1e4', '0x10', '2147483648'])(
    'rejects %j as a timeout override, naming the variable',
    (value) => {
      expect(() => resolveDaemonRequestDeadlines({}, { DKG_API_READ_TIMEOUT_MS: value })).toThrow(
        `DKG_API_READ_TIMEOUT_MS must be a whole number of milliseconds from 1 to 2147483647, got "${value}"`,
      );
      expect(() => resolveDaemonRequestDeadlines({}, { DKG_API_LONG_TIMEOUT_MS: value })).toThrow(
        `DKG_API_LONG_TIMEOUT_MS must be a whole number of milliseconds from 1 to 2147483647, got "${value}"`,
      );
    },
  );

  it('accepts the longest delay a Node timer honours', () => {
    expect(resolveDaemonRequestDeadlines({}, { DKG_API_READ_TIMEOUT_MS: '2147483647' }).readTimeoutMs)
      .toBe(2_147_483_647);
    expect(resolveDaemonRequestDeadlines({}, { DKG_API_LONG_TIMEOUT_MS: '1' }).longTimeoutMs)
      .toBe(30_000);
  });

  it('validates a variable only when no explicit option replaces it, read first', () => {
    const invalid = { DKG_API_READ_TIMEOUT_MS: 'soon', DKG_API_LONG_TIMEOUT_MS: 'later' };
    expect(() => resolveDaemonRequestDeadlines({}, invalid)).toThrow(/^DKG_API_READ_TIMEOUT_MS/u);
    expect(() => resolveDaemonRequestDeadlines({ readTimeoutMs: 20 }, invalid))
      .toThrow(/^DKG_API_LONG_TIMEOUT_MS/u);
    expect(deadlinesOf(resolveDaemonRequestDeadlines({ readTimeoutMs: 20, longTimeoutMs: 1_000 }, invalid)))
      .toEqual([60_000, 20, 1_000]);
  });
});

describe('the retryable authority answer', () => {
  const READ = { error: 'x', code: DAEMON_READ_AUTHORITY_UNAVAILABLE_CODE, retryable: true };
  const OWN = { error: 'x', code: DAEMON_AUTHORITY_UNAVAILABLE_CODE, retryable: true };

  it('is the 503 that carries a retryable authority code, and nothing else', () => {
    expect(isRetryableDaemonAuthorityAnswer(503, READ)).toBe(true);
    expect(isRetryableDaemonAuthorityAnswer(503, OWN)).toBe(true);
    for (const [status, body] of [
      [500, READ], [200, READ], [503, { ...READ, retryable: 'true' }], [503, { code: READ.code }],
      [503, { code: 'STORE_SCHEDULER_BUSY', retryable: true }], [503, { code: 7, retryable: true }],
      [503, null], [503, 'text'], [503, undefined],
    ] as Array<[number, unknown]>) {
      expect(isRetryableDaemonAuthorityAnswer(status, body), JSON.stringify([status, body])).toBe(false);
    }
  });

  it('can be narrowed to the codes a request repeats on', () => {
    expect(isRetryableDaemonAuthorityAnswer(503, READ, [DAEMON_AUTHORITY_UNAVAILABLE_CODE])).toBe(false);
    expect(isRetryableDaemonAuthorityAnswer(503, OWN, [DAEMON_AUTHORITY_UNAVAILABLE_CODE])).toBe(true);
    expect(isRetryableDaemonAuthorityAnswer(503, OWN, [])).toBe(false);
  });

  it('reads Retry-After as delta-seconds or an HTTP-date, and anything else as absent', () => {
    expect(parseDaemonRetryAfterMs('3')).toBe(3_000);
    expect(parseDaemonRetryAfterMs(' 0 ')).toBe(0);
    const now = Date.parse('Fri, 30 Oct 2026 09:00:00 GMT');
    expect(parseDaemonRetryAfterMs('Fri, 30 Oct 2026 09:00:07 GMT', now)).toBe(7_000);
    expect(parseDaemonRetryAfterMs('Fri, 30 Oct 2026 08:59:00 GMT', now)).toBe(0);
    expect(parseDaemonRetryAfterMs('Mon, 99 Foo 2026 09:00:07 GMT', now)).toBeUndefined();
    for (const value of [null, undefined, '', '-1', '3.5', 'soon', '1e3', 'Fri, 30 Oct 2026']) {
      expect(parseDaemonRetryAfterMs(value, now), String(value)).toBeUndefined();
    }
  });

  it('waits its back-off, or Retry-After when that is longer, and stops at its bound', () => {
    expect(DAEMON_AUTHORITY_RETRY_DELAYS_MS.map((_, retry) => daemonAuthorityRetryDelayMs(retry, null)))
      .toEqual([1_000, 2_000, 4_000, 8_000]);
    expect([0, 1, 2, 3].map(retry => daemonAuthorityRetryDelayMs(retry, '3'))).toEqual([3_000, 3_000, 4_000, 8_000]);
    expect(daemonAuthorityRetryDelayMs(DAEMON_AUTHORITY_RETRY_DELAYS_MS.length, '1')).toBeNull();
    const longest = String(DAEMON_AUTHORITY_RETRY_MAX_DELAY_MS / 1_000);
    expect(daemonAuthorityRetryDelayMs(0, longest)).toBe(DAEMON_AUTHORITY_RETRY_MAX_DELAY_MS);
    expect(daemonAuthorityRetryDelayMs(0, `${longest}1`)).toBeNull();
    expect(daemonAuthorityRetryDelayMs(0, '9'.repeat(400))).toBeNull();
  });
});
