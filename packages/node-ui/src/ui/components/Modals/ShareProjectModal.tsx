import React, { useState, useEffect } from 'react';
import {
  authHeaders, addParticipant, removeParticipant, listParticipants,
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
  // Multiaddrs are observed so we can refuse to emit an invite before this
  // node has any remotely-dialable address. Without this gate the curator
  // could paste an invite from a freshly-started NAT'd node whose AutoRelay
  // hasn't yet reserved a circuit, and the joiner's DHT walk would return
  // a record with only LAN/loopback addrs that no remote peer can reach.
  // Codex review on PR #431 surfaced this as a follow-up to the DHT-only
  // invite migration; we gate copy here rather than punting it to the
  // joiner's "unreachable" branch because failing fast on the curator side
  // is much cheaper than the joiner's 90s catchup deadline.
  const [multiaddrs, setMultiaddrs] = useState<string[]>([]);
  const [allowedAgents, setAllowedAgents] = useState<string[]>([]);
  const [newAgent, setNewAgent] = useState('');
  const [addingAgent, setAddingAgent] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
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
        if (Array.isArray(data?.multiaddrs)) {
          setMultiaddrs(data.multiaddrs.filter((m: unknown): m is string => typeof m === 'string'));
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

  // Refuse to emit a peer-id invite until we have at least one
  // remotely-dialable multiaddr. Otherwise the DHT record we're about to
  // ask the joiner to look up will only contain LAN/loopback addrs that no
  // remote node can reach — guaranteed-broken invite. A curator who legitimately
  // wants to share a "bare" cgId invite (public CG, joiner discovers us via
  // gossip) can still copy the contextGraphId directly from the URL.
  const inviteReady = peerId !== null && multiaddrs.some(isMultiaddrRemotelyDialable);
  const invitePayload = inviteReady
    ? `${contextGraphId}\n${peerId}`
    : contextGraphId;

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    }).catch(() => {});
  };

  const handleAddAgent = async (addr?: string) => {
    const address = (addr ?? newAgent).trim();
    if (!address) return;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      setAgentError('Invalid Ethereum address (expected 0x... 40 hex chars)');
      return;
    }
    setAddingAgent(true);
    setAgentError(null);
    try {
      await addParticipant(contextGraphId, address);
      setAllowedAgents((prev) => [...new Set([...prev, address])]);
      setNewAgent('');
    } catch (err: any) {
      setAgentError(err?.message || 'Failed to add agent');
    } finally {
      setAddingAgent(false);
    }
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

  const allowedSet = new Set(allowedAgents.map(a => a.toLowerCase()));
  const availablePeers = networkAgents.filter(
    (a) => a.agentAddress && !allowedSet.has(a.agentAddress.toLowerCase()),
  );

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
              {/* Network Agents (Peer Directory) */}
              {availablePeers.length > 0 && (
                <div className="v10-form-group">
                  <label className="v10-form-label">Network Agents</label>
                  <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 8 }}>
                    Connected agents on the network. Click + to add to the allowlist.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
                    {availablePeers.map((a) => (
                      <div key={a.peerId} style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '6px 10px', borderRadius: 6, fontSize: 11,
                        background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
                      }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{a.name}</span>
                          <span style={{
                            color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', fontSize: 10,
                          }}>
                            {a.agentAddress}
                          </span>
                        </div>
                        <button
                          onClick={() => handleAddAgent(a.agentAddress!)}
                          disabled={addingAgent}
                          style={{
                            background: 'var(--accent-primary)', color: '#fff', border: 'none',
                            cursor: 'pointer', borderRadius: 4, fontSize: 11, padding: '4px 10px',
                            fontWeight: 600, whiteSpace: 'nowrap',
                          }}
                          title={`Add ${a.name} to allowlist`}
                        >
                          + Add
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Allowed Agents section */}
              <div className="v10-form-group">
                <label className="v10-form-label">Allowed Agents</label>
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 8 }}>
                  Only agents on this list can read and write to the project. Add by Ethereum address or pick from network agents above.
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

                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    className="v10-form-input"
                    type="text"
                    placeholder="0x..."
                    value={newAgent}
                    onChange={(e) => { setNewAgent(e.target.value); setAgentError(null); }}
                    style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11 }}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddAgent(); }}
                  />
                  <button
                    className="v10-modal-btn primary"
                    onClick={() => handleAddAgent()}
                    disabled={!newAgent.trim() || addingAgent}
                    style={{ whiteSpace: 'nowrap', fontSize: 11 }}
                  >
                    {addingAgent ? 'Adding…' : 'Add Agent'}
                  </button>
                </div>
                {agentError && (
                  <div style={{ fontSize: 10, color: 'var(--accent-red, #ef4444)', marginTop: 4 }}>{agentError}</div>
                )}
              </div>

              <div className="v10-form-divider" />

              {/* Invite code */}
              <div className="v10-form-group">
                <label className="v10-form-label">Invite Code</label>
                {!inviteReady && (
                  <div style={{
                    padding: '8px 12px', borderRadius: 6, fontSize: 11, marginBottom: 8,
                    background: 'rgba(245, 158, 11, 0.1)',
                    border: '1px solid rgba(245, 158, 11, 0.3)',
                    color: 'var(--accent-amber, #f59e0b)',
                  }}>
                    <strong>Peer-id invite not ready yet.</strong> Your node has no
                    remotely-dialable address yet (no circuit-relay reservation, no public
                    interface). The invite below is the bare project ID — joiners can subscribe
                    if the project is <em>open</em>, but for <em>curated</em> projects they need
                    to dial this node directly to send a join request, which won't work until
                    AutoRelay negotiates a reservation. Re-open this modal in a few seconds to
                    pick up the peer-id-enhanced form.
                  </div>
                )}
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
                    title={inviteReady ? undefined : 'Bare project ID (works for open projects). Wait for AutoRelay to upgrade to a peer-id invite for curated projects.'}
                  >
                    {copied === 'invite' ? 'Copied' : (inviteReady ? 'Copy Invite' : 'Copy Project ID')}
                  </button>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 4 }}>
                  Share this with collaborators. They paste it into <strong>Join Project</strong> on their node.
                  {inviteReady ? (
                    <>
                      {' '}Their daemon dials your node by peer id over the libp2p DHT, so the
                      invite stays valid even if your relay or public IP changes.
                      {allowedAgents.length > 0 ? (
                        <> The invitee must have their agent address on the allowlist, or they can submit a signed join request for your approval.</>
                      ) : (
                        <> Since no allowlist is set, anyone with this code can join.</>
                      )}
                    </>
                  ) : (
                    <>
                      {' '}This is the bare project ID — sufficient for <em>open</em> projects
                      (joiners discover via gossip without dialing your node).
                      {allowedAgents.length > 0 ? (
                        <> Because this project has an allowlist, joiners would also need to dial your node to submit a signed join request — that path won't work until AutoRelay negotiates a circuit-relay reservation. Re-open this modal then to copy the peer-id-enhanced form.</>
                      ) : (
                        <> For curated projects, re-open this modal once AutoRelay has negotiated to copy the peer-id-enhanced form.</>
                      )}
                    </>
                  )}
                </div>
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
