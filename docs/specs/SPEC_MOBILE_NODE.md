# DKG Mobile Node

**Status**: DRAFT v0.1  
**Date**: 2026-02-28  
**Scope**: Run a DKG edge node on iOS and Android via nodejs-mobile + React Native.  
**Depends on**: @origintrail-official/dkg-agent, @origintrail-official/dkg-core, @origintrail-official/dkg-storage, @origintrail-official/dkg-publisher, @origintrail-official/dkg-chain  

---

## 1. Problem Statement

DKG edge nodes currently run as long-lived Node.js daemon processes on
desktops and servers. Users want to participate in the network from their
phones — sending messages, publishing knowledge, querying the graph, and
receiving data — without needing a separate machine running 24/7.

### Goals

- A native iOS and Android app that runs a real DKG edge node on-device.
- Reuse the existing `@origintrail-official/dkg-agent`, `@origintrail-official/dkg-core`, `@origintrail-official/dkg-storage`,
  `@origintrail-official/dkg-query`, `@origintrail-official/dkg-publisher`, and `@origintrail-official/dkg-chain` packages unchanged.
- New packages only where mobile-specific bridging or UI is required.
- The mobile node is a first-class peer: it has its own PeerId, can
  publish knowledge assets, send/receive messages, and sync with peers.
- Offline-first: the node works without connectivity and syncs when
  network is available.

### Non-goals (v1)

- Running a relay/core node on mobile.
- Background sync while the app is fully suspended (OS limitation).
- Supporting tablets with different layouts (use phone layout everywhere).

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  React Native App (UI Thread)                           │
│  ┌───────────────────────────────────────────────────┐  │
│  │  @origintrail-official/dkg-mobile-ui                                   │  │
│  │  React Native screens: Messages, Explorer,        │  │
│  │  Dashboard, Publish, Settings, Onboarding         │  │
│  └──────────────┬────────────────────────────────────┘  │
│                 │  JSON bridge (nodejs.channel)          │
│  ┌──────────────┴────────────────────────────────────┐  │
│  │  Node.js Thread (nodejs-mobile)                   │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │  @origintrail-official/dkg-mobile-bridge                         │  │  │
│  │  │  RPC dispatcher, lifecycle, state sync      │  │  │
│  │  └──────────┬──────────────────────────────────┘  │  │
│  │             │                                     │  │
│  │  ┌──────────┴──────────────────────────────────┐  │  │
│  │  │  Existing packages (UNCHANGED)              │  │  │
│  │  │  @origintrail-official/dkg-agent → @origintrail-official/dkg-core → @origintrail-official/dkg-storage     │  │  │
│  │  │          → @origintrail-official/dkg-publisher → @origintrail-official/dkg-chain      │  │  │
│  │  │          → @origintrail-official/dkg-query                       │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Thread model

| Thread | Runtime | Responsibilities |
|--------|---------|-----------------|
| UI thread | React Native (Hermes) | Screens, navigation, animations |
| Node.js thread | nodejs-mobile (Node 18 LTS) | DKG agent, libp2p, storage, crypto |

Communication is via the `nodejs-mobile-react-native` bridge: bidirectional
JSON message passing over named event channels. The Node.js thread is a
singleton — it starts once and persists for the app's lifetime.

---

## 3. New Packages

Three new packages are added to the monorepo. Existing packages remain
unchanged.

### 3.1 `packages/mobile` — React Native App

The React Native application shell. Contains all mobile UI screens,
navigation, and platform-specific configuration.

```
packages/mobile/
├── app.json
├── package.json
├── babel.config.js
├── metro.config.js
├── index.js                       # RN entry point
├── nodejs-assets/
│   └── nodejs-project/
│       ├── package.json           # Node.js thread entry
│       └── main.js                # boots @origintrail-official/dkg-mobile-bridge
├── src/
│   ├── App.tsx                    # Root navigator
│   ├── bridge/
│   │   └── client.ts             # RN-side bridge client (typed RPC)
│   ├── screens/
│   │   ├── Onboarding.tsx         # First-run setup (name, import key)
│   │   ├── Dashboard.tsx          # Status, peers, connection info
│   │   ├── Messages.tsx           # Peer-to-peer chat
│   │   ├── Explorer.tsx           # SPARQL query + results
│   │   ├── Publish.tsx            # Publish triples
│   │   └── Settings.tsx           # Config, export key, relay
│   ├── components/                # Shared UI components
│   ├── hooks/                     # React hooks (useBridge, useAgent, etc.)
│   └── theme/                     # Colors, typography
├── ios/
│   └── ...                        # Xcode project (auto-generated)
└── android/
    └── ...                        # Gradle project (auto-generated)
```

**Key dependencies:**
- `react-native` (0.76.x — last version with stable legacy bridge)
- `nodejs-mobile-react-native`
- `@react-navigation/native` + `@react-navigation/bottom-tabs`
- `react-native-keychain` (secure key storage)
- `@react-native-async-storage/async-storage` (config persistence)
- `react-native-fs` (filesystem access for N-Quads persistence)

### 3.2 `packages/mobile-bridge` — Node.js Thread Entry Point

Runs inside the nodejs-mobile thread. Boots the DKG agent and exposes an
RPC interface over the bridge channel.

```
packages/mobile-bridge/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts          # Entry: start agent, register RPC handlers
    ├── rpc.ts            # RPC dispatcher (method → handler mapping)
    ├── lifecycle.ts      # Pause/resume handling
    └── events.ts         # Push events to RN (new message, peer connect, etc.)
```

**Key dependencies:**
- Workspace: `@origintrail-official/dkg-agent`, `@origintrail-official/dkg-core`, `@origintrail-official/dkg-storage`, `@origintrail-official/dkg-query`,
  `@origintrail-official/dkg-publisher`, `@origintrail-official/dkg-chain`
- `nodejs-mobile-react-native` (for `rn-bridge` module)

### 3.3 `packages/mobile-ui` — Shared React Native Components (optional)

If the mobile UI grows large, extract shared components here. Initially,
all UI lives in `packages/mobile/src/`. This package is created only if
needed.

---

## 4. Bridge Protocol

The React Native ↔ Node.js bridge uses JSON message passing. All
communication follows a request/response RPC pattern with push events for
unsolicited updates.

### 4.1 Message Format

```typescript
// RN → Node.js (request)
interface BridgeRequest {
  id: string;        // unique request ID (uuid)
  method: string;    // RPC method name
  params?: unknown;  // method-specific parameters
}

// Node.js → RN (response)
interface BridgeResponse {
  id: string;        // matches request ID
  result?: unknown;  // success payload
  error?: string;    // error message (if failed)
}

// Node.js → RN (push event, no request ID)
interface BridgeEvent {
  event: string;     // event name
  data: unknown;     // event payload
}
```

### 4.2 RPC Methods

These methods mirror the HTTP API in `daemon.ts` but run over the bridge
instead of HTTP.

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `agent.start` | `{ name, relayPeers, chainConfig? }` | `{ peerId }` | Boot the agent |
| `agent.stop` | — | `{ ok }` | Graceful shutdown |
| `agent.status` | — | `{ peerId, peers, relayConnected, uptime }` | Node status |
| `agent.peers` | — | `{ agents: Agent[] }` | Discovered agents |
| `chat.send` | `{ to, text }` | `{ delivered, error? }` | Send message |
| `chat.history` | `{ peer?, limit?, since? }` | `{ messages: Message[] }` | Message history |
| `query.sparql` | `{ sparql, paranet? }` | `{ bindings }` | SPARQL query |
| `publish.triples` | `{ paranetId, quads, privateQuads? }` | `{ kcId }` | Publish KA |
| `paranet.list` | — | `{ paranets }` | List paranets |
| `paranet.create` | `{ id, name, description? }` | `{ uri }` | Create paranet |
| `config.get` | — | `{ config }` | Read config |
| `config.set` | `{ key, value }` | `{ ok }` | Update config |

### 4.3 Push Events

Events are pushed from the Node.js thread to React Native without a
preceding request.

| Event | Data | Trigger |
|-------|------|---------|
| `chat.received` | `{ from, text, ts, peerName? }` | Incoming chat message |
| `peer.connected` | `{ peerId, name? }` | New peer connection |
| `peer.disconnected` | `{ peerId }` | Peer disconnection |
| `sync.progress` | `{ paranet, received, total? }` | Sync in progress |
| `sync.complete` | `{ paranet, triples }` | Sync finished |
| `agent.ready` | `{ peerId }` | Agent fully started |
| `agent.error` | `{ message }` | Fatal agent error |
| `relay.status` | `{ connected: boolean }` | Relay connection change |

---

## 5. Native Module Strategy

### 5.1 Oxigraph

Oxigraph is the critical native dependency. Three options, in order of
preference:

**Option A — Oxigraph WASM in Node.js thread (recommended for v1).**
The `oxigraph` npm package ships a WASM build that works in Node.js 18+.
It runs in-memory with no native compilation needed.

- Pros: Zero cross-compilation. Works immediately on all platforms.
- Cons: In-memory only (must serialize/deserialize on start/stop).
  Higher memory usage than native. WASM memory cannot shrink.
- Mitigation: Persist to N-Quads file on pause/stop (already implemented
  in `@origintrail-official/dkg-storage` via `flushToDisk`). Limit dataset size for mobile
  (see §7.2).

**Option B — Cross-compiled native Oxigraph via napi-rs.**
Compile the Rust Oxigraph bindings for `aarch64-linux-android`,
`armv7-linux-androideabi`, and `aarch64-apple-ios` using the Android NDK
and iOS SDK. Package as prebuilds.

- Pros: Native performance. Disk-backed store possible.
- Cons: Complex build pipeline. Requires maintaining prebuilds for 4+
  targets. napi-rs + nodejs-mobile is untested territory.
- When: Consider for v2 if WASM memory is a bottleneck.

**Option C — Replace Oxigraph with a pure-JS SPARQL engine.**
Use a JavaScript triple store (e.g., `n3` + `comunica`).

- Pros: No native code at all.
- Cons: Significantly slower SPARQL evaluation. Large dependency tree.
  Would require changes to `@origintrail-official/dkg-storage` (violates "unchanged" goal).
- When: Only if Options A and B both fail.

**Recommendation: Start with Option A.** The existing `@origintrail-official/dkg-storage`
package already imports `oxigraph` — the WASM version loads transparently
in Node.js. No changes to `@origintrail-official/dkg-storage` are needed.

### 5.2 libp2p Transports

The existing `@origintrail-official/dkg-core` configures libp2p with TCP and WebSocket
transports. On mobile:

- **TCP works** inside the nodejs-mobile thread (it has full Node.js
  `net` module access).
- **WebSocket works** as a fallback.
- **Circuit relay** is already implemented and essential for mobile nodes
  behind carrier-grade NAT.

No transport changes are needed for v1. The mobile node connects to the
relay via TCP (same as desktop edge nodes). If TCP proves unreliable on
certain mobile networks, WebSocket-only mode can be added as a config
option without changing `@origintrail-official/dkg-core`.

### 5.3 Crypto

All crypto uses `@noble/*` libraries (ed25519, x25519, sha256,
xchacha20-poly1305). These are pure JavaScript — no native modules. They
work in any JS runtime including nodejs-mobile.

### 5.4 Blockchain (ethers)

`ethers` is pure JavaScript with no native dependencies. Works unchanged
on nodejs-mobile.

### 5.5 protobufjs

`protobufjs` has optional native components but falls back to pure JS.
Works on nodejs-mobile without changes.

---

## 6. Mobile Lifecycle

### 6.1 App States

```
                    ┌────────────┐
              ┌────►│  ACTIVE    │◄────┐
              │     │  (agent    │     │
              │     │   running) │     │
              │     └─────┬──────┘     │
              │           │ app        │ app
          app │     backgrounded  foregrounded
     launched │           │            │
              │     ┌─────▼──────┐     │
              │     │ BACKGROUND │─────┘
              │     │ (paused,   │
              │     │  flushing) │
              │     └─────┬──────┘
              │           │ OS kills (iOS ~30s, Android varies)
              │     ┌─────▼──────┐
              └─────┤  STOPPED   │
                    │ (cold start│
                    │  needed)   │
                    └────────────┘
```

### 6.2 State Transitions

| Transition | Action |
|-----------|--------|
| STOPPED → ACTIVE | Load config from AsyncStorage. Deserialize store from N-Quads file. Start agent. Connect to relay. Publish profile. |
| ACTIVE → BACKGROUND | `rn_bridge.app.on('pause')` fires. Flush store to disk. Close non-relay connections. Release pause lock. |
| BACKGROUND → ACTIVE | `rn_bridge.app.on('resume')` fires. Re-check relay connection (watchdog). Re-sync missed data. |
| BACKGROUND → STOPPED | OS terminated the app. No callback — data was already flushed on BACKGROUND entry. |

### 6.3 Startup Sequence

```typescript
// packages/mobile-bridge/src/index.ts (runs in Node.js thread)
import rn_bridge from 'rn-bridge';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { RpcDispatcher } from './rpc.js';
import { pushEvent } from './events.js';

const dataDir = rn_bridge.app.datadir() + '/dkg';
let agent: DKGAgent | null = null;

const rpc = new RpcDispatcher();

rpc.register('agent.start', async (params) => {
  agent = await DKGAgent.create({
    name: params.name,
    framework: 'DKG-Mobile',
    dataDir,
    relayPeers: params.relayPeers,
    nodeRole: 'edge',
    chainConfig: params.chainConfig,
  });

  agent.onChat((text, senderPeerId, convId) => {
    pushEvent('chat.received', { from: senderPeerId, text, ts: Date.now() });
  });

  await agent.start();
  await agent.publishProfile();

  pushEvent('agent.ready', { peerId: agent.peerId });
  return { peerId: agent.peerId };
});

// ... register other RPC methods ...

// Handle app lifecycle
rn_bridge.app.on('pause', (lock) => {
  if (agent) {
    agent.flushStore().then(() => lock.release());
  } else {
    lock.release();
  }
});

rn_bridge.app.on('resume', () => {
  // Watchdog will auto-reconnect relay
});

// Listen for RPC requests from React Native
rn_bridge.channel.on('message', (msg) => rpc.dispatch(msg));
```

---

## 7. Constraints & Mitigations

### 7.1 Node.js Version (18 LTS)

nodejs-mobile ships Node.js 18.20.4. All existing packages must work on
Node 18. Current `package.json` engines fields should be checked.

**Action**: Verify all workspace packages build and pass tests on
Node 18. Add `"engines": { "node": ">=18" }` to root `package.json` if
not already present.

### 7.2 Memory Budget

Mobile devices have limited RAM. WASM memory grows monotonically.

| Device tier | Available RAM | Triple budget (estimated) |
|------------|---------------|--------------------------|
| Low-end (2GB) | ~150MB for app | ~50,000 triples |
| Mid-range (4GB) | ~300MB for app | ~150,000 triples |
| High-end (8GB) | ~500MB for app | ~300,000 triples |

**Mitigations:**
- Track oxigraph WASM heap size. Warn user when approaching 80% budget.
- Implement paranet subscription limits (subscribe to N paranets max).
- Aggressive garbage collection of expired conversations.
- Periodic store compaction (dump to N-Quads, reload).

### 7.3 Battery

Continuous P2P networking drains battery. The mobile node should be
conservative:

- Disable mDNS discovery (not useful on mobile networks).
- Set GossipSub heartbeat interval higher (e.g., 5s instead of 1s).
- Close idle peer connections after 60s (keep only relay).
- Pause all networking when app is backgrounded.

### 7.4 Bridge Serialization Overhead

All RN ↔ Node.js messages are JSON-serialized. For large payloads
(query results, bulk triples), this adds latency.

**Mitigations:**
- Paginate large results (max 100 items per bridge message).
- For publish: pass file path instead of triple content over bridge;
  Node.js thread reads file directly from shared filesystem.
- Consider MessagePack or CBOR if JSON becomes a bottleneck (v2).

### 7.5 iOS Background Execution

iOS suspends apps ~30 seconds after backgrounding. The node cannot
maintain connections in the background.

**Mitigations:**
- Flush store immediately on pause (§6.2).
- On resume, the existing relay watchdog handles reconnection.
- Consider iOS Background Tasks API for brief sync windows (v2).
- Push notifications via a relay-side push service for incoming
  messages while suspended (v2).

---

## 8. Onboarding Flow

First-time setup on mobile:

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  1. Welcome      │    │  2. Identity     │    │  3. Network      │
│                  │    │                  │    │                  │
│  "Run your own   │───►│  Enter agent     │───►│  Connect to      │
│   DKG node on    │    │  name            │    │  relay           │
│   your phone"    │    │                  │    │  (auto-filled    │
│                  │    │  [ ] Generate    │    │   from testnet   │
│  [Get Started]   │    │      new key     │    │   config)        │
│                  │    │  [ ] Import      │    │                  │
│                  │    │      existing    │    │  [Start Node]    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                                       │
                                               ┌───────▼─────────┐
                                               │  4. Dashboard    │
                                               │                  │
                                               │  Node running!   │
                                               │  PeerId: ...     │
                                               │  Relay: ✓        │
                                               │  Peers: 3        │
                                               └──────────────────┘
```

**Key import**: Users who already run a desktop node can import their
existing Ed25519 private key to get the same PeerId on mobile. Keys are
stored in `react-native-keychain` (iOS Keychain / Android Keystore).

---

## 9. Security

### 9.1 Key Storage

- Ed25519 keypair stored in platform secure enclave via
  `react-native-keychain` (hardware-backed on modern devices).
- Never transmitted over the bridge as plaintext. The Node.js thread
  reads the key from a file in the app's sandboxed `datadir`.
- Biometric unlock option for accessing the key.

### 9.2 Data at Rest

- N-Quads store file is in the app sandbox (encrypted at rest by iOS
  Data Protection / Android file-based encryption).
- Private triples remain encrypted in storage (same as desktop).

### 9.3 Network

- All peer communication is encrypted (Noise protocol via libp2p).
- Messages are end-to-end encrypted (XChaCha20-Poly1305).
- No additional mobile-specific attack surface.

---

## 10. Implementation Plan

### Phase 1 — Skeleton App (1-2 weeks)

| # | Task | Status |
|---|------|--------|
| 1.1 | Create `packages/mobile` with React Native 0.76 + TypeScript | NEEDS IMPL |
| 1.2 | Integrate `nodejs-mobile-react-native` | NEEDS IMPL |
| 1.3 | Create `packages/mobile-bridge` with minimal RPC (echo test) | NEEDS IMPL |
| 1.4 | Verify bridge communication works on iOS simulator + Android emulator | NEEDS IMPL |
| 1.5 | Verify `@origintrail-official/dkg-agent` loads in nodejs-mobile (Node 18 compat) | NEEDS IMPL |

### Phase 2 — Core Agent on Mobile (2-3 weeks)

| # | Task | Status |
|---|------|--------|
| 2.1 | Implement full RPC dispatcher in mobile-bridge | NEEDS IMPL |
| 2.2 | Boot DKGAgent in Node.js thread, connect to relay | NEEDS IMPL |
| 2.3 | Verify oxigraph WASM works in nodejs-mobile thread | NEEDS IMPL |
| 2.4 | Implement lifecycle handlers (pause → flush, resume → reconnect) | NEEDS IMPL |
| 2.5 | Onboarding flow (name, key generation, relay config) | NEEDS IMPL |
| 2.6 | Secure key storage via react-native-keychain | NEEDS IMPL |
| 2.7 | Test on physical iOS device and Android device | NEEDS IMPL |

### Phase 3 — UI Screens (2-3 weeks)

| # | Task | Status |
|---|------|--------|
| 3.1 | Dashboard screen (status, peers, relay indicator) | NEEDS IMPL |
| 3.2 | Messages screen (send/receive, delivery checkmarks) | NEEDS IMPL |
| 3.3 | Explorer screen (SPARQL query, results table) | NEEDS IMPL |
| 3.4 | Publish screen (create triples, publish to paranet) | NEEDS IMPL |
| 3.5 | Settings screen (config, export key, relay management) | NEEDS IMPL |
| 3.6 | Push events for real-time updates (new message badge, etc.) | NEEDS IMPL |

### Phase 4 — Polish & Release (1-2 weeks)

| # | Task | Status |
|---|------|--------|
| 4.1 | Memory profiling and optimization | NEEDS IMPL |
| 4.2 | Battery usage testing and tuning | NEEDS IMPL |
| 4.3 | Error handling and crash recovery | NEEDS IMPL |
| 4.4 | App icons, splash screen, store metadata | NEEDS IMPL |
| 4.5 | TestFlight (iOS) and Internal Testing (Android) builds | NEEDS IMPL |

### Phase 5 — v2 Enhancements (future)

| # | Task | Status |
|---|------|--------|
| 5.1 | Native oxigraph build via napi-rs cross-compilation | NEEDS SPEC |
| 5.2 | iOS Background Tasks API for periodic sync | NEEDS SPEC |
| 5.3 | Push notifications for incoming messages (relay-side service) | NEEDS SPEC |
| 5.4 | Graph visualization (port @origintrail-official/dkg-graph-viz to react-native-skia) | NEEDS SPEC |
| 5.5 | QR code pairing between desktop and mobile nodes | NEEDS SPEC |

---

## 11. Package Impact Summary

| Package | Changes needed | Notes |
|---------|---------------|-------|
| `@origintrail-official/dkg-agent` | **None** | Used as-is in Node.js thread |
| `@origintrail-official/dkg-core` | **None** | TCP transport works in nodejs-mobile |
| `@origintrail-official/dkg-storage` | **None** | Oxigraph WASM loads transparently |
| `@origintrail-official/dkg-query` | **None** | Pure JS on top of storage |
| `@origintrail-official/dkg-publisher` | **None** | Pure JS + ethers |
| `@origintrail-official/dkg-chain` | **None** | Pure JS + ethers |
| `@origintrail-official/dkg` | **None** | Not used on mobile |
| `@origintrail-official/dkg-node-ui` | **None** | Not used on mobile |
| `@origintrail-official/dkg-graph-viz` | **None** | Not used on mobile (v1) |
| **`@origintrail-official/dkg-mobile`** | **NEW** | React Native app |
| **`@origintrail-official/dkg-mobile-bridge`** | **NEW** | Node.js thread RPC layer |

**Zero changes to existing packages.** The mobile app is entirely
additive — two new packages that compose the existing stack.

---

## 12. Risks & Open Questions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| R1 | nodejs-mobile stuck on Node 18 (EOL Apr 2025) | Medium | Monitor project. Node 18 still works; no Node 20+ APIs are used. Fallback: fork nodejs-mobile. |
| R2 | Oxigraph WASM memory growth on mobile | Medium | Monitor heap. Implement triple budget. Periodic compaction. |
| R3 | React Native New Architecture breaks nodejs-mobile bridge | Medium | Pin RN 0.76. The nodejs-mobile maintainer is tracking this. |
| R4 | TCP transport unreliable on mobile carrier networks | Low | Already connect via relay. Can add WebSocket-only mode. |
| R5 | App Store rejection (running a P2P node) | Low | The app performs legal networking. Crypto wallets with similar tech are approved. |
| R6 | napi-rs cross-compilation for oxigraph fails | Low | Only affects v2 native build. WASM is the v1 path. |
| R7 | Bridge serialization bottleneck for large datasets | Low | Paginate. Pass file paths. Consider binary encoding in v2. |
