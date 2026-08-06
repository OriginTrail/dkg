# Test fixtures

## `fake-prime-agent-host.mjs`

A child-process stand-in for the Prime Agent extension host, for CI where no
real Prime Agent exists. It imports the **built** bundle
(`../extension/dist/extension.js` — the artifact that actually ships; exits `2`
with a message on stderr if the bundle is missing) and emulates the host
contract the extension relies on (documented in the header of
`extension/src/extension.ts`):

- the default-export factory is called **once per started session** — each
  factory call owns its closure, the same isolation the real host gets by
  re-importing the module with `moduleCache: false`;
- `pi.on(event, handler)` registry; session identity reaches the extension
  only via `ctx.sessionManager.getSessionId()` on the handler ctx;
- `session_start` / `session_shutdown` handlers are awaited; a session is gone
  only after its shutdown handlers settle;
- many concurrent sessions per process, exactly like a real worker.

Everything is real except the LLM: real process boundary, real pid for
liveness checks, real loopback HTTP bridge, real descriptor files.
`PRIME_AGENT_CODING_AGENT_DIR` is read by the extension itself — the host
never resolves or overrides it. Handler `event` payloads carry only the fields
the extension reads (e.g. no `reason` on `session_shutdown`).

### Control protocol

JSON lines over stdin/stdout, one object per line.

| direction | line | meaning |
| --- | --- | --- |
| in | `{"cmd":"start-session","sessionId":"..."}` | call the factory, dispatch `session_start` |
| in | `{"cmd":"agent-start","sessionId":"..."}` | dispatch `agent_start` |
| in | `{"cmd":"message-update","sessionId":"...","eventType":"text_delta","delta":"..."}` | dispatch `message_update` |
| in | `{"cmd":"agent-end","sessionId":"..."}` | dispatch `agent_end` |
| in | `{"cmd":"shutdown-session","sessionId":"..."}` | dispatch `session_shutdown`, forget the session |
| in | `{"cmd":"auto-respond","sessionId":"...","reply":"..."}` | arm auto-respond for the session |
| in | `{"cmd":"exit"}` | shut down every live session, exit `0` |
| out | `{"evt":"ready"}` | boot complete, commands accepted |
| out | `{"evt":"session-started","sessionId":...}` | `session_start` handlers settled |
| out | `{"evt":"user-message","sessionId":...,"text":...,"options":...}` | extension called `pi.sendUserMessage` |
| out | `{"evt":"session-shutdown","sessionId":...}` | `session_shutdown` handlers settled |
| out | `{"evt":"error","message":...}` | bad command / handler failure |

Commands are applied strictly in stdin order (a queue serializes them even
though handlers are async). `auto-respond` may target a session that has not
started yet; sent before `start-session`, it is guaranteed active by the time
`session-started` is observed. Once armed, every `pi.sendUserMessage` triggers
— asynchronously, via `setImmediate` — `agent_start`, one `text_delta`
`message_update` with the configured reply, then `agent_end`, so a driver that
cannot interleave commands (e.g. Playwright) still gets a full turn. The
`user-message` event is emitted either way.

Closing stdin is equivalent to `{"cmd":"exit"}`.

## Bundle freshness

The host imports `../extension/dist/extension.js` — the built artifact, not
the TypeScript source — and only checks that it *exists* (exit 2 when
missing). It cannot check freshness: in CI the bundle arrives via the
build-outputs artifact whose tar-preserved mtimes predate the shard's own
checkout, so any mtime comparison against `extension/src` would false-fail
there. When running an integration test file directly (IDE, bare `vitest run`
from `packages/cli`), rebuild after editing the extension source —
`pnpm --filter @origintrail-official/dkg-adapter-prime-agent build` — or run
the adapter's `pnpm test`, whose script chain-builds the extension first.
