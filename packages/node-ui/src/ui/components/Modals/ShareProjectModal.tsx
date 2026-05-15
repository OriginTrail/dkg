import React, { useState, useEffect } from 'react';
import {
  authHeaders, removeParticipant, listParticipants,
  fetchAgents, listJoinRequests, approveJoinRequest, rejectJoinRequest,
  type PendingJoinRequest,
} from '../../api.js';

interface NetworkAgent {
  agentUri: string;
  name: string;
  peerId: string;
  agentAddress?: string;
  connectionStatus: string;
}

interface ShareProjectModalProps {
  open: boolean;
  onClose: () => void;
  contextGraphId: string;
  contextGraphName: string;
}

function truncAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Reject DNS hostnames that no remote peer could resolve to a public
 * address: `localhost`, mDNS `.local`, RFC 6761 reserved TLDs (`.test`,
 * `.example`, `.invalid`, `.localhost`), `.localdomain`, IPv4/IPv6
 * literals embedded in the DNS field, and single-label hostnames
 * (which usually only resolve via a corporate DNS suffix).
 *
 * Codex review on PR #431 (round 3) flagged that the previous heuristic
 * blanket-accepted every dns multiaddr, so a freshly-started node
 * announcing /dns/localhost/tcp/9090/p2p/xxx would pass the invite gate
 * and produce a guaranteed-broken invite.
 */
export function isLocalOrInternalHostname(host: string): boolean {
  if (typeof host !== 'string' || host.length === 0) return true;
  const h = host.toLowerCase();
  if (h === 'localhost') return true;
  if (h.endsWith('.local') || h.endsWith('.localhost')) return true;
  if (h.endsWith('.test') || h.endsWith('.example')) return true;
  if (h.endsWith('.invalid') || h.endsWith('.localdomain')) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return true;
  if (/^\[?[0-9a-f:]+\]?$/.test(h) && h.includes(':')) return true;
  if (!h.includes('.')) return true;
  return false;
}

/**
 * Cheap heuristic: would a remote dialer have ANY chance of reaching us
 * via this multiaddr? A remote-dialable address is one of:
 *   • `/p2p-circuit/...` — relay reservation, dialable through the relay.
 *   • `/dns(4|6|addr)/<host>/...` — domain-based, host is a publicly
 *     resolvable FQDN (NOT `localhost`, `*.local`, `*.test`, etc.).
 *   • `/ip4/<public>/...` — non-RFC1918, non-loopback, non-CGNAT.
 *   • `/ip6/<global-unicast>/...` — not loopback, not link-local, not ULA.
 * Conservative: anything we can't classify counts as NOT dialable, so the
 * invite-ready gate biases toward refusing rather than emitting a broken
 * invite. The joiner's DHT walk would surface the same negative answer
 * eventually, but we'd rather fail fast on the curator side than make the
 * joiner sit through a 90s catchup deadline.
 *
 * KEEP IN SYNC with `isPublicLikeAddress` in
 * `packages/core/src/node.ts` — the daemon uses the same predicate to
 * decide when to log "Node is remotely-dialable".
 */
export function isMultiaddrRemotelyDialable(addr: string): boolean {
  if (typeof addr !== 'string' || addr.length === 0) return false;
  if (addr.includes('/p2p-circuit/')) return true;
  const dnsMatch = addr.match(/^\/(?:dns|dns4|dns6|dnsaddr)\/([^/]+)\//);
  if (dnsMatch) return !isLocalOrInternalHostname(dnsMatch[1]);

  const ipv4 = addr.match(/^\/ip4\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\//);
  if (ipv4) {
    const o = ipv4[1].split('.').map(Number);
    if (o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
    if (o[0] === 0 || o[0] === 127) return false;            // unspecified / loopback
    if (o[0] === 10) return false;                            // RFC1918 /8
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false; // RFC1918 /12
    if (o[0] === 192 && o[1] === 168) return false;           // RFC1918 /16
    if (o[0] === 169 && o[1] === 254) return false;           // link-local
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return false; // CGNAT 100.64/10
    if (o[0] >= 224) return false;                            // multicast / reserved
    return true;
  }

  const ipv6 = addr.match(/^\/ip6\/([^/]+)\//);
  if (ipv6) {
    const ip = ipv6[1].toLowerCase();
    if (ip === '::' || ip === '::1') return false;
    if (ip.startsWith('fe80')) return false; // link-local
    if (/^f[cd]/.test(ip)) return false;     // unique-local (ULA)
    if (ip.startsWith('ff')) return false;   // multicast
    return true;
  }

  return false;
}

export function ShareProjectModal({ open, onClose, contextGraphId, contextGraphName }: ShareProjectModalProps) {
  const [copied, setCopied] = useState<string | null>(null);
  // V10 invites carry the curator's libp2p peer id, not a hand-picked
  // multiaddr. The joiner's daemon resolves the peer's current addresses
  // via Kademlia DHT (`libp2p.peerRouting.findPeer`) at dial time, so the
  // invite stays valid across relay rotations, NAT changes, and public-IP
  // moves. The previous multiaddr-in-invite design broke whenever the
  // chosen relay rotated under the curator.
  const [peerId, setPeerId] = useState<string | null>(null);
  const [allowedAgents, setAllowedAgents] = useState<string[]>([]);
  // Surfaced only for join-request approve/reject errors. The previous
  // address-paste add-path that also wrote here was removed; the only
  // way to add an agent now is to share the text invite and approve
  // the inbound signed join request.
  const [agentError, setAgentError] = useState<string | null>(null);
  // Kept solely for the friendly-name lookup on already-allowlisted
  // entries (so the Allowed Agents list still renders peer names where
  // we know them rather than just the raw 0x address). The previous
  // "Network Agents" picker that surfaced this list as add-suggestions
  // was removed because on long-running testnet nodes the historical
  // agent registry routinely accumulates 1500+ rows dominated by
  // offline smoke-node and one-off test agents — overwhelming and not
  // actionable as an invite path. Inviting now goes through the text
  // invite + signed join request flow exclusively.
  const [networkAgents, setNetworkAgents] = useState<NetworkAgent[]>([]);
  const [pendingRequests, setPendingRequests] = useState<PendingJoinRequest[]>([]);
  const [processingRequest, setProcessingRequest] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'allowlist' | 'requests'>('allowlist');

  useEffect(() => {
    if (!open) return;
    fetch('/api/status', { headers: authHeaders() })
      .then(r => r.json())
      .then((data: any) => {
        if (typeof data?.peerId === 'string' && data.peerId.length > 0) {
          setPeerId(data.peerId);
        }
      })
      .catch(() => {});

    listParticipants(contextGraphId)
      .then((data) => setAllowedAgents(data.allowedAgents))
      .catch(() => setAllowedAgents([]));

    fetchAgents()
      .then((data: any) => {
        const agents: NetworkAgent[] = (data.agents ?? []).filter(
          (a: any) => a.connectionStatus !== 'self',
        );
        setNetworkAgents(agents);
      })
      .catch(() => setNetworkAgents([]));

    listJoinRequests(contextGraphId)
      .then((data) => setPendingRequests(data.requests))
      .catch(() => setPendingRequests([]));
  }, [open, contextGraphId]);

  if (!open) return null;

  // Always emit `<cgId>\n<peerId>` once peer-id is loaded. The earlier
  // `inviteReady` gate (which required at least one publicly-dialable
  // multiaddr) was defensive against "no AutoRelay reservation yet"
  // scenarios, but it's now too strict in two ways:
  //   1. V10's `forwardJoinRequest` REQUIRES the curator peer id —
  //      the bare-cgId fallback is dead, would always throw on submit.
  //   2. LAN / loopback / CGNAT addrs are perfectly dialable from same-
  //      machine (devnet) and same-LAN peers; the DHT record carries
  //      them. The "remotely dialable" predicate was about INTERNET
  //      reachability — too pessimistic for local / LAN testing.
  // Worst case (truly isolated curator) the joiner gets an error on
  // submit, identical to today.
  const invitePayload = peerId ? `${contextGraphId}\n${peerId}` : null;

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    }).catch(() => {});
  };

  const handleRemoveAgent = async (addr: string) => {
    try {
      await removeParticipant(contextGraphId, addr);
      setAllowedAgents((prev) => prev.filter((a) => a !== addr));
    } catch {
      // silently fail
    }
  };

  const handleApprove = async (agentAddress: string) => {
    setProcessingRequest(agentAddress);
    try {
      await approveJoinRequest(contextGraphId, agentAddress);
      setPendingRequests((prev) => prev.filter((r) => r.agentAddress !== agentAddress));
      setAllowedAgents((prev) => [...new Set([...prev, agentAddress])]);
    } catch (err: any) {
      setAgentError(err?.message || 'Failed to approve');
    } finally {
      setProcessingRequest(null);
    }
  };

  const handleReject = async (agentAddress: string) => {
    setProcessingRequest(agentAddress);
    try {
      await rejectJoinRequest(contextGraphId, agentAddress);
      setPendingRequests((prev) => prev.filter((r) => r.agentAddress !== agentAddress));
    } catch (err: any) {
      setAgentError(err?.message || 'Failed to reject');
    } finally {
      setProcessingRequest(null);
    }
  };

  return (
    <div className="v10-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v10-modal-box" style={{ maxWidth: 560 }}>
        <div className="v10-modal-header">
          <div className="v10-modal-title">Share Project</div>
          <div className="v10-modal-subtitle">
            Invite agents to collaborate on <strong>{contextGraphName}</strong>.
          </div>
        </div>

        <div className="v10-modal-body">
          {/* Tabs */}
          <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderBottom: '1px solid var(--border-default)' }}>
            <button
              onClick={() => setActiveTab('allowlist')}
              style={{
                padding: '8px 16px', fontSize: 12, fontWeight: activeTab === 'allowlist' ? 600 : 400,
                background: 'none', border: 'none', cursor: 'pointer',
                color: activeTab === 'allowlist' ? 'var(--text-primary)' : 'var(--text-tertiary)',
                borderBottom: activeTab === 'allowlist' ? '2px solid var(--accent-primary)' : '2px solid transparent',
              }}
            >
              Allowlist
            </button>
            <button
              onClick={() => setActiveTab('requests')}
              style={{
                padding: '8px 16px', fontSize: 12, fontWeight: activeTab === 'requests' ? 600 : 400,
                background: 'none', border: 'none', cursor: 'pointer',
                color: activeTab === 'requests' ? 'var(--text-primary)' : 'var(--text-tertiary)',
                borderBottom: activeTab === 'requests' ? '2px solid var(--accent-primary)' : '2px solid transparent',
                position: 'relative',
              }}
            >
              Join Requests
              {pendingRequests.length > 0 && (
                <span style={{
                  position: 'absolute', top: 4, right: 4,
                  background: 'var(--accent-red, #ef4444)', color: '#fff',
                  borderRadius: 999, fontSize: 9, fontWeight: 700,
                  padding: '1px 5px', minWidth: 16, textAlign: 'center',
                }}>
                  {pendingRequests.length}
                </span>
              )}
            </button>
          </div>

          {activeTab === 'allowlist' && (
            <>
              {/* Allowed Agents — read-only audit list. Agents are added
                  exclusively via the text-invite + signed-join-request flow
                  (see Invite Code below + the Join Requests tab). The ✕
                  button revokes access for an existing participant. */}
              <div className="v10-form-group">
                <label className="v10-form-label">Allowed Agents</label>
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 8 }}>
                  Only agents on this list can read and write to the project. To add someone, share the Invite Code below — they'll send a signed join request you can approve in the <strong>Join Requests</strong> tab.
                </div>

                {allowedAgents.length > 0 && (
                  <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {allowedAgents.map((addr) => {
                      const peer = networkAgents.find(
                        (a) => a.agentAddress?.toLowerCase() === addr.toLowerCase(),
                      );
                      return (
                        <div key={addr} style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '6px 10px', borderRadius: 6, fontSize: 11,
                          fontFamily: 'var(--font-mono)', background: 'var(--bg-surface)',
                          border: '1px solid var(--border-default)',
                        }}>
                          <span style={{ color: 'var(--text-primary)' }}>
                            {peer ? (
                              <><span style={{ fontFamily: 'var(--font-body)', fontWeight: 500 }}>{peer.name}</span>{' '}<span style={{ color: 'var(--text-tertiary)', fontSize: 10 }}>{truncAddr(addr)}</span></>
                            ) : addr}
                          </span>
                          <button
                            onClick={() => handleRemoveAgent(addr)}
                            style={{
                              background: 'none', border: 'none', cursor: 'pointer',
                              color: 'var(--text-tertiary)', fontSize: 12, padding: '0 4px',
                            }}
                            title="Remove agent"
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {allowedAgents.length === 0 && (
                  <div style={{
                    padding: '8px 12px', borderRadius: 6, fontSize: 11,
                    color: 'var(--text-tertiary)', background: 'var(--bg-surface)',
                    border: '1px dashed var(--border-default)', marginBottom: 8,
                  }}>
                    No agents on allowlist — project is open to anyone who subscribes.
                  </div>
                )}
              </div>

              <div className="v10-form-divider" />

              {/* Invite code */}
              <div className="v10-form-group">
                <label className="v10-form-label">Invite Code</label>
                {invitePayload === null ? (
                  <div style={{
                    padding: '8px 12px', borderRadius: 6, fontSize: 11,
                    color: 'var(--text-tertiary)', background: 'var(--bg-surface)',
                    border: '1px dashed var(--border-default)',
                  }}>
                    Loading peer ID…
                  </div>
                ) : (
                  <div style={{ position: 'relative' }}>
                    <pre style={{
                      background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
                      borderRadius: 6, padding: '10px 12px', fontSize: 11, lineHeight: 1.6,
                      fontFamily: 'var(--font-mono)', color: 'var(--text-primary)',
                      overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                    }}>
                      {invitePayload}
                    </pre>
                    <button
                      className="v10-modal-btn primary"
                      onClick={() => copyToClipboard(invitePayload, 'invite')}
                      style={{
                        position: 'absolute', top: 6, right: 6, fontSize: 10, padding: '4px 10px', height: 26,
                        cursor: 'pointer',
                      }}
                    >
                      {copied === 'invite' ? 'Copied' : 'Copy Invite'}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

          {activeTab === 'requests' && (
            <div className="v10-form-group">
              <label className="v10-form-label">Pending Join Requests</label>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 8 }}>
                Agents who submitted a signed request to join this project. Approve to add them to the allowlist.
              </div>

              {pendingRequests.length === 0 && (
                <div style={{
                  padding: '16px 12px', borderRadius: 6, fontSize: 11, textAlign: 'center',
                  color: 'var(--text-tertiary)', background: 'var(--bg-surface)',
                  border: '1px dashed var(--border-default)',
                }}>
                  No pending join requests.
                </div>
              )}

              {pendingRequests.map((req) => (
                <div key={req.agentAddress} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 10px', borderRadius: 6, fontSize: 11,
                  background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
                  marginBottom: 4,
                }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {req.name && (
                      <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{req.name}</span>
                    )}
                    <span style={{
                      color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', fontSize: 10,
                    }}>
                      {req.agentAddress}
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>
                      Requested {new Date(req.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => handleApprove(req.agentAddress)}
                      disabled={processingRequest === req.agentAddress}
                      style={{
                        background: 'rgba(34, 197, 94, 0.15)', color: 'var(--accent-green, #22c55e)',
                        border: '1px solid rgba(34, 197, 94, 0.3)', cursor: 'pointer',
                        borderRadius: 4, fontSize: 10, padding: '4px 10px', fontWeight: 600,
                      }}
                    >
                      {processingRequest === req.agentAddress ? '…' : 'Approve'}
                    </button>
                    <button
                      onClick={() => handleReject(req.agentAddress)}
                      disabled={processingRequest === req.agentAddress}
                      style={{
                        background: 'rgba(239, 68, 68, 0.1)', color: 'var(--accent-red, #ef4444)',
                        border: '1px solid rgba(239, 68, 68, 0.2)', cursor: 'pointer',
                        borderRadius: 4, fontSize: 10, padding: '4px 10px', fontWeight: 600,
                      }}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}

              {agentError && (
                <div style={{ fontSize: 10, color: 'var(--accent-red, #ef4444)', marginTop: 4 }}>{agentError}</div>
              )}
            </div>
          )}
        </div>

        <div className="v10-modal-footer">
          <button className="v10-modal-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
