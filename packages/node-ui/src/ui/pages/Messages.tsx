import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useFetch, shortId } from '../hooks.js';
import { fetchAgents, fetchMessages, sendPeerMessage, fetchStatus } from '../api.js';

interface Message {
  ts: number;
  direction: 'in' | 'out';
  peer: string;
  peerName?: string;
  text: string;
}

interface Agent {
  name: string;
  peerId: string;
  framework?: string;
  nodeRole?: string;
}

const POLL_INTERVAL = 3_000;

export function MessagesPage() {
  const { data: agentData } = useFetch(fetchAgents, [], 15_000);
  const { data: statusData } = useFetch(fetchStatus, [], 30_000);

  const agents: Agent[] = (agentData?.agents ?? []).filter(
    (a: Agent) => a.peerId !== statusData?.peerId,
  );
  const agentNameMap = new Map<string, string>();
  for (const a of agentData?.agents ?? []) agentNameMap.set(a.peerId, a.name);

  const [selectedPeer, setSelectedPeer] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastPollTs = useRef(0);

  const selectedAgent = agents.find(a => a.peerId === selectedPeer) ??
    (agentData?.agents ?? []).find((a: Agent) => a.peerId === selectedPeer);

  const pollMessages = useCallback(async () => {
    if (!selectedPeer) return;
    try {
      const name = agentNameMap.get(selectedPeer) ?? selectedPeer;
      const res = await fetchMessages({ peer: name, limit: 200 });
      setMessages(res.messages);
    } catch { /* ignore poll errors */ }
  }, [selectedPeer]);

  useEffect(() => {
    if (!selectedPeer) { setMessages([]); return; }
    pollMessages();
    const timer = setInterval(pollMessages, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [selectedPeer, pollMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-select first peer if none selected
  useEffect(() => {
    if (!selectedPeer && agents.length > 0) {
      setSelectedPeer(agents[0].peerId);
    }
  }, [agents, selectedPeer]);

  const handleSend = async () => {
    if (!inputText.trim() || !selectedPeer || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const name = agentNameMap.get(selectedPeer) ?? selectedPeer;
      const result = await sendPeerMessage(name, inputText.trim());
      if (result.delivered) {
        setInputText('');
        await pollMessages();
      } else {
        setSendError(result.error ?? 'Message not delivered');
      }
    } catch (err: any) {
      setSendError(err.message);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div>
      <h1 className="page-title">Messages</h1>

      <div className="chat-layout">
        {/* Peer list sidebar */}
        <div className="chat-peers">
          <div className="chat-peers-header">Agents</div>
          {agents.length === 0 ? (
            <div className="chat-peers-empty">No agents discovered</div>
          ) : (
            agents.map((a: Agent) => (
              <button
                key={a.peerId}
                className={`chat-peer-item ${selectedPeer === a.peerId ? 'active' : ''}`}
                onClick={() => { setSelectedPeer(a.peerId); setSendError(null); }}
              >
                <div className="chat-peer-name">{a.name}</div>
                <div className="chat-peer-meta">
                  <span className={`badge ${a.nodeRole === 'core' ? 'badge-info' : 'badge-success'}`}>
                    {a.nodeRole ?? 'edge'}
                  </span>
                  <span className="mono" style={{ fontSize: 11 }}>{shortId(a.peerId, 6)}</span>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Chat area */}
        <div className="chat-main">
          {selectedPeer ? (
            <>
              <div className="chat-header">
                <div className="chat-header-name">{selectedAgent?.name ?? shortId(selectedPeer, 12)}</div>
                <div className="chat-header-meta mono">{shortId(selectedPeer, 16)}</div>
              </div>

              <div className="chat-messages">
                {messages.length === 0 ? (
                  <div className="chat-empty">
                    No messages yet. Send one to start a conversation.
                  </div>
                ) : (
                  messages.map((msg, i) => (
                    <div key={i} className={`chat-bubble ${msg.direction === 'out' ? 'chat-bubble-out' : 'chat-bubble-in'}`}>
                      <div className="chat-bubble-text">{msg.text}</div>
                      <div className="chat-bubble-time">
                        {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="chat-input-area">
                {sendError && (
                  <div className="chat-send-error">{sendError}</div>
                )}
                <div className="chat-input-row">
                  <input
                    className="chat-input"
                    type="text"
                    placeholder={`Message ${selectedAgent?.name ?? 'agent'}...`}
                    value={inputText}
                    onChange={e => setInputText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={sending}
                  />
                  <button
                    className="btn btn-primary chat-send-btn"
                    onClick={handleSend}
                    disabled={sending || !inputText.trim()}
                  >
                    {sending ? (
                      <svg className="chat-spinner" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="30 10" /></svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 1l14 7-14 7V9l10-1-10-1V1z"/></svg>
                    )}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="chat-no-selection">
              <svg width="48" height="48" viewBox="0 0 16 16" fill="var(--text-muted)" opacity="0.3">
                <path d="M1 2h14v9H5l-4 3V2z"/>
              </svg>
              <div>Select an agent to start chatting</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
