import type { ServerResponse } from 'node:http';
import { respondContextGraphReadAuthorityUnavailable } from '../src/daemon/http-utils.js';

declare const res: ServerResponse;

// The renderer takes a complete attribution; `unknown` is decoded only from thrown markers (#2834).
// @ts-expect-error source, reason and dependency are required
respondContextGraphReadAuthorityUnavailable(res, {});

respondContextGraphReadAuthorityUnavailable(res, {
  source: 'registered-chain',
  reason: 'local-existence-unavailable',
  dependency: 'store',
});
