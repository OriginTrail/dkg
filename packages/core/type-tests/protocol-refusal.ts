import type { PeerId } from '@libp2p/interface';
import type { DKGNode } from '@origintrail-official/dkg-core';
import { watchProtocolRefusal, type DialProtocolHost } from '../../../scripts/testing/protocol-refusal.js';

/**
 * The type surface of the shared late-handler hook (scripts/testing/protocol-refusal.ts).
 * It lives here, not in the runtime test, because a `@ts-expect-error` in a file that vitest
 * strips types from proves nothing: `pnpm --dir packages/core run build` runs this file through
 * `tsc` (tsconfig.type-tests.json, `rootDir` two levels up so the helper is in the program), and
 * packages/core/turbo.json lists the helper as an input of core's `build` task so a change to it
 * re-runs this check. Nothing here runs.
 */
const PROTOCOL = '/test/late-handler/1.0.0';

// A real node passes with no cast and no type arguments. This is the host type of both real
// callers: core's router e2e passes `DKGNode.libp2p`, and the agent's connect-race test passes
// `DKGAgent.node.libp2p`, where `DKGAgent.node` is a `DKGNode` (dkg-agent-base.ts).
declare const node: DKGNode;
watchProtocolRefusal(node.libp2p, PROTOCOL, () => {});

// The watcher's declared parameter type stays callable with a libp2p peer: its dial signature is
// not narrowed to `never` (which no caller could satisfy), whatever the host's own types are.
declare const declaredHost: Parameters<typeof watchProtocolRefusal>[0];
declare const peerId: PeerId;
void declaredHost.dialProtocol(peerId, [PROTOCOL]);

// A test's own host, with its own peer, options and result types. The watcher infers them from it
// and leaves the host's dial signature as declared, so a wrong type is an error at the call site.
interface FakeDialOptions {
  readonly timeoutMs?: number;
}
declare const host: DialProtocolHost<string, FakeDialOptions, string>;
declare const protocols: string[];

watchProtocolRefusal(host, PROTOCOL, () => {});
const stream: Promise<string> = host.dialProtocol('peer', protocols, { timeoutMs: 1 });
void stream;
// @ts-expect-error the peer is a string
host.dialProtocol(42, protocols);
// @ts-expect-error the protocols are a string or a list of strings
host.dialProtocol('peer', 42);
// @ts-expect-error the options' timeoutMs is a number
host.dialProtocol('peer', protocols, { timeoutMs: 'soon' });
// @ts-expect-error the result is a string
const count: Promise<number> = host.dialProtocol('peer', protocols);
void count;
// @ts-expect-error a host without a dialProtocol is not watchable
watchProtocolRefusal({}, PROTOCOL, () => {});
// @ts-expect-error type arguments that disagree with the host's own
watchProtocolRefusal<number, FakeDialOptions, string>(host, PROTOCOL, () => {});
