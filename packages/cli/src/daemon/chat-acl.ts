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
import type { ChatConfig } from '../config.js';

export const DEFAULT_CHAT_MAX_TEXT_BYTES = 32 * 1024;
export const DEFAULT_CHAT_MAX_MESSAGES_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60_000;
const TRUSTED_CG_MEMBERSHIP_SOURCE = 'allowed-peer';

export interface BuildChatAclOpts {
  /** From `DkgConfig.chat`. Missing or disabled means fail-closed. */
  config?: ChatConfig;
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
  /** Test seam for the rolling per-peer rate window. */
  now?: () => number;
}

/**
 * Build the authorisation callback for inbound chats. The daemon always
 * receives a callback: omitted/disabled/invalid config rejects inbound chat.
 *
 * Failure modes are surfaced via the returned `reason` string and end
 * up as `{ delivered: false, error: <reason> }` on the sender, so the
 * operator on the other side sees a useful explanation rather than a
 * silent drop.
 */
export function buildChatAcl(opts: BuildChatAclOpts): ChatAclCheck {
  const chat = opts.config;
  const cfg = chat?.acl;
  const mode = cfg?.mode ?? 'deny';
  const maxTextBytes = positiveIntegerOrDefault(
    chat?.limits?.maxTextBytes,
    DEFAULT_CHAT_MAX_TEXT_BYTES,
  );
  const maxMessagesPerMinute = positiveIntegerOrDefault(
    chat?.limits?.maxMessagesPerMinute,
    DEFAULT_CHAT_MAX_MESSAGES_PER_MINUTE,
  );
  const acceptedAtByPeer = new Map<string, number[]>();
  const now = opts.now ?? Date.now;

  if (chat?.enabled !== true) {
    opts.log?.('Chat: disabled (default-off); ALL inbound chats will be rejected');
  } else if (mode === 'deny') {
    opts.log?.('Chat ACL: mode=deny; ALL inbound chats will be rejected');
  } else if (mode === 'trusted') {
    const peers = new Set(cfg?.peerAllowlist ?? []);
    const cgs = new Set(cfg?.trustedContextGraphIds ?? []);
    opts.log?.(
      `Chat ACL: mode=trusted (${peers.size} exact peer${peers.size === 1 ? '' : 's'}, ${cgs.size} trusted CG${cgs.size === 1 ? '' : 's'}; CG source=${TRUSTED_CG_MEMBERSHIP_SOURCE})`,
    );
  } else if (mode === 'any') {
    opts.log?.('Chat ACL: mode=any (explicit legacy open mode; accepting all authenticated peers)');
  }

  if (chat?.enabled !== true || mode === 'deny' || mode === 'trusted' || mode === 'any') {
    // Already logged above.
  } else if (mode === 'peer-allowlist') {
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

  const applyLimits = (
    senderPeerId: string,
    payload: Parameters<ChatAclCheck>[1],
    verdict: ReturnType<ChatAclCheck>,
  ): ReturnType<ChatAclCheck> => {
    if (!verdict.accept) return verdict;
    if ((payload.textBytes ?? 0) > maxTextBytes) {
      return {
        accept: false,
        reason: `resource limit: chat text exceeds ${maxTextBytes} UTF-8 bytes`,
      };
    }
    const timestamp = now();
    const cutoff = timestamp - RATE_WINDOW_MS;
    const recent = (acceptedAtByPeer.get(senderPeerId) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= maxMessagesPerMinute) {
      acceptedAtByPeer.set(senderPeerId, recent);
      return {
        accept: false,
        reason: `rate limit: at most ${maxMessagesPerMinute} chat message${maxMessagesPerMinute === 1 ? '' : 's'} per minute per sender`,
      };
    }
    recent.push(timestamp);
    acceptedAtByPeer.set(senderPeerId, recent);
    return verdict;
  };

  return (senderPeerId, payload) => {
    if (chat?.enabled !== true) {
      return { accept: false, reason: 'unauthorized: inbound chat is disabled' };
    }

    // Loopback is an explicit opt-in, not an ambient bypass.
    try {
      if (chat.allowLoopback === true && senderPeerId === opts.getLocalPeerId()) {
        return applyLimits(senderPeerId, payload, { accept: true });
      }
    } catch {
      // getLocalPeerId can throw if called before agent.start; in that
      // case fall through to the policy check below — there's no way a
      // chat arrived before the agent was up anyway.
    }

    if (mode === 'deny') {
      return { accept: false, reason: 'unauthorized: receiver chat ACL is deny' };
    }

    if (mode === 'trusted') {
      if ((cfg?.peerAllowlist ?? []).includes(senderPeerId)) {
        return applyLimits(senderPeerId, payload, { accept: true });
      }
      const claim = payload.contextGraphId;
      if (!claim) {
        return {
          accept: false,
          reason: 'unauthorized: sender is not a trusted peer and supplied no trusted contextGraphId claim',
        };
      }
      if (!(cfg?.trustedContextGraphIds ?? []).includes(claim)) {
        return {
          accept: false,
          reason: `unauthorized: contextGraphId=${claim} is not explicitly trusted for chat`,
        };
      }
      if (!isTrustedContextGraphPeer(opts.dashDb, claim, senderPeerId)) {
        return {
          accept: false,
          reason: `unauthorized: sender has no active curator-managed peer membership in ${claim}`,
        };
      }
      return applyLimits(senderPeerId, payload, {
        accept: true,
        verifiedContextGraphId: claim,
      });
    }

    if (mode === 'any') {
      return applyLimits(senderPeerId, payload, { accept: true });
    }

    if (mode === 'peer-allowlist') {
      const list = cfg?.peerAllowlist ?? [];
      if (list.includes(senderPeerId)) {
        return applyLimits(senderPeerId, payload, { accept: true });
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
        return applyLimits(senderPeerId, payload, {
          accept: true,
          verifiedContextGraphId: cgId,
        });
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
          return applyLimits(senderPeerId, payload, {
            accept: true,
            verifiedContextGraphId: claim,
          });
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
          return applyLimits(senderPeerId, payload, { accept: true });
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

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function isTrustedContextGraphPeer(
  dashDb: DashboardDB,
  contextGraphId: string,
  peerId: string,
): boolean {
  return dashDb.listContextGraphMembers(contextGraphId).some(
    (member) =>
      member.principal_type === 'node' &&
      member.principal_id === peerId &&
      member.status === 'active' &&
      member.source === TRUSTED_CG_MEMBERSHIP_SOURCE,
  );
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
