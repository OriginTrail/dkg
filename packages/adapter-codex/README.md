# Codex in the DKG Node UI

Local Codex chat integrated into the DKG v10 UI. This adapter serves the UI on
`127.0.0.1:9210`, proxies the existing DKG node on port 9200, and connects to the
installed Codex App Server over stdio. The existing DKG daemon is unchanged.

Features: existing and new conversations, streaming, tool activity, stop,
approval and input requests, browser reconnect, file attachments, and downloads
of files inside the conversation workspace. The DKG MCP tools are attached to
conversations opened through this adapter. Messages also become private local
Working Memory assets by default, with configurable capture and recall for the
DKG UI and native Codex. The adapter never automatically shares or publishes them.

## Runtime

Node 22+, the Codex CLI, a running DKG node, and a built `packages/node-ui/dist-ui`
are required. Live chat and graph persistence were verified against Codex Desktop
0.153.1 and DKG 10.0.15 (244f6943fe7a909a23fe3671c9da088de942f8ed). The PR also
integrates `testnet-canary` at 514bf9bcd, with focused tests and a production UI
build on that base; live validation against its DKG 10.0.16 node is still pending.

Set `DKG_CODEX_CONFIG` to an absolute JSON config path, then run
`node packages/adapter-codex/src/server.mjs`. The config accepts:

```json
{
  "port": 9210,
  "dkgPort": 9200,
  "dkgHome": "/absolute/path/.dkg",
  "codexBinary": "/absolute/path/codex",
  "dkgCli": "/absolute/path/dkg/dist/cli.js",
  "defaultCwd": "/absolute/workspace",
  "stateDir": "/absolute/path/.dkg/codex",
  "uiDir": "/absolute/path/packages/node-ui/dist-ui",
  "initialThreadId": "optional-existing-codex-thread-id"
}
```

The bridge explicitly selects Codex's local thread store and requests legacy
history for new conversations. That is necessary for this Codex build's complete
read/resume support. It doesn't change the user's global Codex configuration.
The model and permission settings come from Codex. Approvals are surfaced to the
user and are never automatically accepted by the adapter.

The bridge binds only to IPv4 loopback. It rejects foreign Host/Origin headers,
uses an HttpOnly SameSite cookie, and requires a custom header for Codex writes.
DKG credentials are read in the server/MCP wrapper and never placed in the browser
or conversation configuration. Uploaded files are owner-readable only; downloads
resolve symlinks and stay within the selected workspace or its own attachments.

## Conversation handoff

Select a conversation and wait for any active desktop turn to finish. The bridge
checks actual saved turn-boundary records because this Codex build labels other
processes' unfinished turns as interrupted. After handoff, continue that
conversation in one interface at a time. The bridge cannot stop another process
from independently opening a conversation that it already owns.

Desktop-only dynamic tools return an explicit unavailable result. The DKG UI has
Codex shell, files, configured MCP tools, and DKG tools, but is not a replacement
for every desktop panel or desktop-specific integration. Live voice is not
implemented. File attachments support up to four files, 4 MB each and 8 MB total.
The adapter is a private workspace package and must be run alongside the DKG
node. Rebuild the UI bundle after updating its source.

## Validation

Run `node --test packages/adapter-codex/test/*.test.mjs`. UI event reducer tests are
in `packages/node-ui/test/codex-events.test.ts`. Build with the repository's
`packages/node-ui` Vite configuration. The full existing UI TypeScript check has
44 pre-existing diagnostics on this base; the integration adds no new diagnostic
categories or messages (some existing line numbers move).

The implementation protocol is based on the [official Codex App Server
documentation](https://learn.chatgpt.com/docs/app-server) and bindings generated
from the installed CLI. The bridge preserves normal Codex authentication; it
does not require a new API key.

## Private conversation memory

The bridge now uses `DkgMemory` to write message graphs as private local Working
Memory assets and perform scoped keyword recall before `turn/start`. Expand
**DKG memory** in the UI to configure capture and recall independently for the
DKG and native interfaces, inspect receipts, or change search scopes. Default
storage is `codex-private-conversations`; automatic capture does not share or
publish assets. Pending writes are durable and retried in conversation order.

`memory-hook.mjs <config.json>` implements native Codex `UserPromptSubmit`,
`PostToolUse`, and `Stop` hooks. It sends only the required prompt, final reply,
and tool metadata to the local bridge with a separate owner-only token. Native
hooks require Codex trust review before running. The DKG bridge sets
`DKG_CODEX_SURFACE=dkg` in its child process to prevent duplicate native capture.
Native intermediate commentary, interrupted partial replies, and automatic
historical import are not part of the hook implementation.

The UI's counts distinguish message/conversation/trace nodes and links to
retrieved evidence. They are not semantic fact-extraction counts. Retrieval
currently uses keyword matching, at most eight evidence entities, and a bounded
context budget. All retrieved evidence is labelled untrusted data.

### Native Codex setup

Start the bridge first so it creates `memory-hook.token` in its state directory.
Merge the following entries into your Codex `hooks.json`, preserving any existing
hooks. Replace `/absolute/path/node`, `/absolute/path/dkg`, and the configuration
path with your installation paths; quote each path in the command if it contains
spaces. Use Node 22 or newer.

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{
      "type": "command",
      "command": "/absolute/path/node /absolute/path/dkg/packages/adapter-codex/src/memory-hook.mjs /absolute/path/config.json",
      "timeout": 20,
      "statusMessage": "Retrieve private DKG memory",
      "additionalContextLimit": 3500
    }] }],
    "PostToolUse": [{ "hooks": [{
      "type": "command",
      "command": "/absolute/path/node /absolute/path/dkg/packages/adapter-codex/src/memory-hook.mjs /absolute/path/config.json",
      "timeout": 20,
      "statusMessage": "Record DKG action trace"
    }] }],
    "Stop": [{ "hooks": [{
      "type": "command",
      "command": "/absolute/path/node /absolute/path/dkg/packages/adapter-codex/src/memory-hook.mjs /absolute/path/config.json",
      "timeout": 20,
      "statusMessage": "Save reply to private DKG memory"
    }] }]
  }
}
```

Review and trust these definitions through Codex's `/hooks` interface, then start
or resume a session. See the [Codex hook trust
documentation](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).
Enabling native capture in DKG settings alone does not activate untrusted hooks.
The hook tests cover authenticated transport, payload filtering, and retry;
activation in a trusted native Codex session still needs manual verification.

Local conversation and outbox files use owner-only permissions, without
additional application-level encryption. Disabling capture pauses future and
pending graph writes; it does not delete previously stored messages. Attachment
contents, semantic fact extraction, and historical chat import are outside this
implementation.
