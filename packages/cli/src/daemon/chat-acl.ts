// daemon/chat-acl.ts
//
// Inbound chat authorisation policy. Layered on top of the existing
// Ed25519 signature check on every libp2p chat message — this decides
// *which* authenticated peers we're willing to talk to, not *whether*
// they are authenticated.
//
// See `ChatAclConfig` in ../config.ts for mode semantics. The runtime
// result is a `ChatAclCheck` callback consumed by
// `DKGAgent.setChatAcl(...)`.

import type { ChatAclCheck } from '@origintrail-official/dkg-agent';
import type { DashboardDB } from '@origintrail-official/dkg-node-ui';
import type { ChatAclConfig } from '../config.js';

export interface BuildChatAclOpts {
  /** From `DkgConfig.chat.acl`. Missing means "no policy" => null callback. */
  config?: ChatAclConfig;
  /** Node UI / dashboard DB the daemon owns. Membership rows live here. */
  dashDb: DashboardDB;
  /**
   * Resolved at call-time so the closure is happy to be installed
   * before `agent.start()` (when `agent.peerId` is not yet available).
   * Throws if called before the agent has its peer id.
   */
  getLocalPeerId: () => string;
  /** Optional logger for ACL transitions and rejected messages. */
  log?: (msg: string) => void;
}

/**
 * Build the authorisation callback for inbound chats. Returns `null`
 * when no policy is configured (legacy "accept all authenticated peers"
 * behaviour).
 *
 * Failure modes are surfaced via the returned `reason` string and end
 * up as `{ delivered: false, error: <reason> }` on the sender, so the
 * operator on the other side sees a useful explanation rather than a
 * silent drop.
 */
export function buildChatAcl(opts: BuildChatAclOpts): ChatAclCheck | null {
  const cfg = opts.config;
  const mode = cfg?.mode ?? 'any';

  if (mode === 'any') {
    opts.log?.('Chat ACL: mode=any (accepting all authenticated peers)');
    return null;
  }

  if (mode === 'peer-allowlist') {
    const list = new Set(cfg?.peerAllowlist ?? []);
    opts.log?.(
      `Chat ACL: mode=peer-allowlist (${list.size} allowed peer${list.size === 1 ? '' : 's'})`,
    );
  } else if (mode === 'scoped') {
    if (!cfg?.contextGraphId) {
      opts.log?.(
        'Chat ACL: mode=scoped but no contextGraphId configured — fail-closed: ALL inbound chats will be rejected',
      );
    } else {
      opts.log?.(`Chat ACL: mode=scoped, contextGraphId=${cfg.contextGraphId}`);
    }
  } else if (mode === 'shared-context-graph') {
    opts.log?.(
      'Chat ACL: mode=shared-context-graph (accept peers that share at least one subscribed CG)',
    );
  } else {
    opts.log?.(`Chat ACL: unknown mode=${mode} — fail-closed`);
  }

  return (senderPeerId, payload) => {
    // Loopback always allowed: a node chatting itself (for local CLI
    // testing, devnet smoke tests, the daemon poking its own inbox).
    try {
      if (senderPeerId === opts.getLocalPeerId()) {
        return { accept: true };
      }
    } catch {
      // getLocalPeerId can throw if called before agent.start; in that
      // case fall through to the policy check below — there's no way a
      // chat arrived before the agent was up anyway.
    }

    if (mode === 'peer-allowlist') {
      const list = cfg?.peerAllowlist ?? [];
      if (list.includes(senderPeerId)) {
        return { accept: true };
      }
      return {
        accept: false,
        reason: 'unauthorized: sender not in peer-allowlist',
      };
    }

    if (mode === 'scoped') {
      const cgId = cfg?.contextGraphId;
      if (!cgId) {
        return {
          accept: false,
          reason:
            "unauthorized: receiver's chat ACL is scoped but no contextGraphId is configured",
        };
      }
      // Reject a mismatched sender claim BEFORE the membership check
      // accepts. A member of cgId who tags their message with a
      // different graph id is impersonating membership of a graph
      // they may not actually belong to, and downstream code uses the
      // claimed value for notifications and logs. Codex PR #510 round
      // 2 flagged this — previously we returned `accept: true` on
      // membership before validating the claim, so the spoofed CG
      // would silently get tagged into notification titles.
      if (payload.contextGraphId && payload.contextGraphId !== cgId) {
        return {
          accept: false,
          reason: `unauthorized: sender claims contextGraphId=${payload.contextGraphId} but receiver is scoped to ${cgId}`,
        };
      }
      if (isActiveNodeMember(opts.dashDb, cgId, senderPeerId)) {
        // CG is verified: either the sender claimed cgId (and we just
        // confirmed claim === receiver's scope above) or they made no
        // claim at all (we still know which CG this conversation is
        // about — it's the receiver's scope). Either way `cgId` is
        // safe to surface to operators as the message's CG context.
        return { accept: true, verifiedContextGraphId: cgId };
      }
      return {
        accept: false,
        reason: `unauthorized: sender is not an active member of ${cgId}`,
      };
    }

    if (mode === 'shared-context-graph') {
      const subs = opts.dashDb
        .listContextGraphSubscriptions()
        .filter((s) => s.subscribed === 1);
      const claim = payload.contextGraphId;
      // Same defence as `scoped`: if the sender supplied a CG claim,
      // it must be one we subscribe to AND they must be an active
      // member of that specific graph. Without this, a sender who is
      // a member of (subscribed) graph A could claim membership in
      // (subscribed) graph B and have downstream tag the chat as B.
      if (claim) {
        const subscribed = subs.some((s) => s.context_graph_id === claim);
        if (!subscribed) {
          return {
            accept: false,
            reason: `unauthorized: sender claims contextGraphId=${claim} but this node does not subscribe to it`,
          };
        }
        if (isActiveNodeMember(opts.dashDb, claim, senderPeerId)) {
          // `claim` is verified — we subscribe to it AND the sender is
          // an active member of it. Safe to surface as the message's
          // CG context.
          return { accept: true, verifiedContextGraphId: claim };
        }
        return {
          accept: false,
          reason: `unauthorized: sender claims contextGraphId=${claim} but is not an active member of it`,
        };
      }
      // No claim from the sender — accept if there is ANY shared
      // graph membership. Downstream will tag the chat without a CG,
      // which is the safe default. We deliberately do NOT pick one
      // shared CG to surface as "verified" because the message
      // itself wasn't tagged, so any choice would be guess-work.
      for (const sub of subs) {
        if (isActiveNodeMember(opts.dashDb, sub.context_graph_id, senderPeerId)) {
          return { accept: true };
        }
      }
      return {
        accept: false,
        reason:
          'unauthorized: sender shares no active context-graph membership with this node',
      };
    }

    return {
      accept: false,
      reason: `unauthorized: unknown ACL mode '${mode}'`,
    };
  };
}

function isActiveNodeMember(
  dashDb: DashboardDB,
  contextGraphId: string,
  peerId: string,
): boolean {
  const members = dashDb.listContextGraphMembers(contextGraphId);
  return members.some(
    (m) =>
      m.principal_type === 'node' &&
      m.principal_id === peerId &&
      m.status === 'active',
  );
}
