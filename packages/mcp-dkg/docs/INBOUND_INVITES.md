# Inbound invite notification surface — investigation + proposal

**Investigation date:** 2026-04-18
**Status:** confirmed gap; deferred to Phase 8 (requires daemon changes, not just UI polish)

## Question

When Operator A invites Operator B's agent to a curated context graph via `POST /api/context-graph/invite`, does Operator B see any passive UI indicator (bell, banner, inbox) on their node-ui without having to know the CG ID and paste it into `JoinProjectModal`?

## Answer: No

The existing notification + SSE infrastructure handles **join-request** flows (Operator B requests to join a CG they already know about; Operator A as curator sees the request; Operator B gets a `join_approved` notification) but does **not** handle the **curator-pushes-allowlist-entry** case.

## What works today

- **Curator side:** `JOIN_REQUEST_RECEIVED` event → `dashDb.insertNotification` + `sseBroadcast('join_request', ...)` → Header notification bell + `useNodeEvents` SSE listener pick it up.
- **Requester side (after curator approves):** `JOIN_APPROVED` event → notification + `sseBroadcast('join_approved', ...)` → same UI pickup.
- `JoinProjectModal` provides a paste-an-invite-code UX, signs the join request, polls `/api/context-graph/<id>/catchup-status` until `done` / `denied` / `failed`.

## What's missing

`POST /api/context-graph/invite` (`packages/cli/src/daemon.ts:4506`) calls `agent.inviteToContextGraph(contextGraphId, peerId)` (`packages/agent/src/dkg-agent.ts:3292`), which only updates the curator's local `_meta` allowlist. There is no:

- Daemon endpoint exposing "invites my agent appears on the allowlist for"
- P2P "you've been invited" message from curator → invitee
- Event bus emission on the invitee's node when their agent's address appears in a remote curator's allowlist (which they'd see via gossip of `_meta` SWM)
- SSE event `context_graph_invite` for the bell to render

## Proposed fix (Phase 8)

Smallest incremental wiring, ordered:

1. **Daemon — detect allowlist membership on meta-sync.** When `_meta` from a curator syncs in and contains an allowlist entry naming this node's agent address, emit `DKGEvent.CONTEXT_GRAPH_INVITED` on the agent's event bus. The detection is a SPARQL query against the just-synced `_meta` graph: `SELECT ?cg WHERE { ?cg dkg:allowedAgent <my-agent-uri> }`.

2. **Daemon — wire the event to notification + SSE.** Mirror the `join_request` / `join_approved` pattern in `daemon.ts`:
   ```ts
   agent.eventBus.on(DKGEvent.CONTEXT_GRAPH_INVITED, (data) => {
     dashDb.insertNotification({
       type: 'context_graph_invite',
       title: 'You have been invited to a project',
       message: `${shortId(data.curatorAgent)} added you to ${shortId(data.contextGraphId)}.`,
       meta: JSON.stringify({ contextGraphId: data.contextGraphId, curatorAgent: data.curatorAgent }),
     });
     sseBroadcast('context_graph_invite', { contextGraphId: data.contextGraphId, curatorAgent: data.curatorAgent });
   });
   ```

3. **UI — extend the SSE listener.** Add `'context_graph_invite'` to the `NodeEventType` union in `packages/node-ui/src/ui/hooks/useNodeEvents.ts` and have `Header.tsx` reload notifications when it fires (already done generically — adding the case is one line).

4. **UI — make the notification clickable.** When the operator clicks an invite notification in the Header bell, open `JoinProjectModal` pre-filled with the `contextGraphId` from `meta.contextGraphId`. Already supported via `JoinProjectModal`'s `initialContextGraphId` prop.

5. **(Optional) Inbox panel.** A dedicated `Inbox` view listing all unread `context_graph_invite` notifications with one-click join buttons. Nice-to-have; the bell badge + click-to-join handles the v1 use case.

Estimated effort: ~half a day. Mostly daemon work; UI is trivial once the events and notifications flow.

## Why we didn't ship it in Phase 7

Phase 7's scope is agent-emitted graph annotations + project ontology + URI convergence. Inbound invite notifications are a separate concern (operator UX vs agent annotation behaviour) and the daemon work is non-trivial enough to warrant its own change (event-bus addition, SPARQL detection logic, allowlist-sync semantics). Better to file it cleanly than to half-ship.

## Workaround for now

Operator A pastes the project ID + multiaddr into a chat or message; Operator B opens `JoinProjectModal` and pastes it. Functional but not passive.
