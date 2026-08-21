import type { IncomingMessage, ServerResponse } from 'node:http';
import { daemonCtx } from './_helpers/daemon-ctx.js';
import type { KafkaPluginCtx } from '../src/handler.js';

// The fixture helper enforces the invariant it documents. This lane is where that is checked:
// `handler.test.ts` itself is not in a typechecked project, so typing the helper alone would be
// documentation. Exercising it here makes the contract real.

declare const base: Omit<KafkaPluginCtx, 'req' | 'res' | 'url' | 'path'>;
declare const req: IncomingMessage;
declare const res: ServerResponse;

// The supported shape: overrides for anything the daemon does NOT derive.
void daemonCtx(base, req, res, { requestAgentAddress: '0xabc' });
void daemonCtx(base, req, res);

// @ts-expect-error `path` is DERIVED from the request. Allowing a caller to set it is how fixtures
// drifted into shapes production never produces, which kept dead fallback branches alive.
void daemonCtx(base, req, res, { path: '/anything' });

// @ts-expect-error Same for `url`. The value is a REAL URL on purpose: with a nonsense string the
// error could come from the value's type rather than from the field being forbidden, so the row
// would have passed for the wrong reason.
void daemonCtx(base, req, res, { url: new URL('http://x/api/kafka/streams') });

// @ts-expect-error `res` is positional too, and was previously untested — a regression re-admitting
// it would have gone unnoticed.
void daemonCtx(base, req, res, { res });

// @ts-expect-error `req` is a positional argument, not an override that can contradict it.
void daemonCtx(base, req, res, { req });
