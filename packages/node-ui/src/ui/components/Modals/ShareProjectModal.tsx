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

export function ShareProjectModal({ open, onClose, contextGraphId, contextGraphName }: ShareProjectModalProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const [peerMultiaddr, setPeerMultiaddr] = useState<string | null>(null);
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
        const addrs: string[] = data.multiaddrs ?? [];
        const publicAddr = addrs.find((a: string) => !a.includes('/127.0.0.1/')) ?? addrs[0] ?? null;
        setPeerMultiaddr(publicAddr);
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

  const invitePayload = peerMultiaddr
    ? `${contextGraphId}\n${peerMultiaddr}`
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
                    style={{ position: 'absolute', top: 6, right: 6, fontSize: 10, padding: '4px 10px', height: 26 }}
                  >
                    {copied === 'invite' ? 'Copied' : 'Copy Invite'}
                  </button>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 4 }}>
                  Share this with collaborators. They paste it into <strong>Join Project</strong> on their node.
                  {allowedAgents.length > 0 ? (
                    <> The invitee must have their agent address on the allowlist, or they can submit a signed join request for your approval.</>
                  ) : (
                    <> Since no allowlist is set, anyone with this code can join.</>
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
