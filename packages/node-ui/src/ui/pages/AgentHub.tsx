import React, { useState, useRef, useEffect } from 'react';

interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  tool?: string;
  ts: string;
}

const INITIAL: Message[] = [
  {
    id: 0,
    role: 'assistant',
    content: 'Agent online. Connected to DKG v9 testnet with access to your Knowledge Assets across 3 paranets. How can I help?',
    ts: 'just now',
  },
];

const AGENT_TOOLS = [
  'dkg:query', 'dkg:publish', 'dkg:verify',
  'memory:recall', 'memory:store', 'graph:traverse',
];

const CANNED: Record<string, Partial<Message>[]> = {
  default: [
    { role: 'assistant', content: 'Let me check the knowledge graph for that…', tool: 'dkg:query' },
    { role: 'assistant', content: 'Found 14 matching Knowledge Assets across the OriginTrail Game and DeSci Research paranets. The most recent was published 3 minutes ago by Agent-Research.' },
  ],
  memory: [
    { role: 'assistant', content: 'Scanning your stored memories…', tool: 'memory:recall' },
    { role: 'assistant', content: 'I have 2,847 Knowledge Assets attributed to your node. The oldest dates to Feb 2026. Want me to export a summary as a new KA?' },
  ],
  publish: [
    { role: 'assistant', content: 'Preparing to publish…', tool: 'dkg:publish' },
    { role: 'assistant', content: 'Published successfully. UAL: did:dkg:base:8453/0xc28f/1291034 — stored by 4 nodes, finalized.' },
  ],
};

function pickResponses(input: string): Partial<Message>[] {
  if (/memory|remember|recall/i.test(input)) return CANNED.memory;
  if (/publish|store|write/i.test(input)) return CANNED.publish;
  return CANNED.default;
}

const AGENTS = [
  { name: 'Agent-Finance',  status: 'active',  color: '#4ade80', tasks: 3 },
  { name: 'Agent-Legal',    status: 'active',  color: '#60a5fa', tasks: 1 },
  { name: 'Agent-Network',  status: 'idle',    color: '#a78bfa', tasks: 0 },
  { name: 'Agent-Research', status: 'active',  color: '#fbbf24', tasks: 5 },
  { name: 'Agent-Audit',    status: 'pending', color: '#f472b6', tasks: 2 },
];

let _mid = 10;

export function AgentHubPage() {
  const [messages, setMessages] = useState<Message[]>(INITIAL);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typing]);

  const send = () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    const userMsg: Message = { id: _mid++, role: 'user', content: text, ts: 'just now' };
    setMessages(prev => [...prev, userMsg]);
    setTyping(true);

    const responses = pickResponses(text);
    let delay = 700;
    responses.forEach(r => {
      setTimeout(() => {
        setMessages(prev => [...prev, { id: _mid++, ts: 'just now', role: 'assistant', ...r } as Message]);
        if (r === responses[responses.length - 1]) setTyping(false);
      }, delay);
      delay += r.tool ? 1200 : 600;
    });
  };

  return (
    <div className="page-section" style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', height: '100%', overflow: 'hidden' }}>

        {/* Chat panel */}
        <div style={{ display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', overflow: 'hidden' }}>
          <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'var(--green-dim)', border: '1px solid rgba(74,222,128,.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>🤖</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>DKG Agent</div>
              <div style={{ fontSize: 11, color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 5 }}>
                <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
                Connected · 3 paranets
              </div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {AGENT_TOOLS.slice(0, 3).map(t => (
                <span key={t} className="mono" style={{ fontSize: 9, padding: '2px 7px', borderRadius: 4, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>{t}</span>
              ))}
            </div>
          </div>

          <div className="chat-area" style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
            {messages.map(m => (
              <div key={m.id} className={`chat-msg ${m.role}`}>
                {m.tool && (
                  <div className="chat-tool">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                    {m.tool}
                  </div>
                )}
                <div className={`chat-bubble ${m.role}`}>{m.content}</div>
                <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4, fontFamily: 'JetBrains Mono, monospace' }}>{m.ts}</div>
              </div>
            ))}
            {typing && (
              <div className="chat-msg assistant">
                <div className="chat-bubble assistant" style={{ display: 'flex', gap: 4, alignItems: 'center', padding: '12px 16px' }}>
                  {[0, 0.2, 0.4].map((d, i) => (
                    <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-muted)', display: 'inline-block', animation: `pulse 1.2s ease ${d}s infinite` }} />
                  ))}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="chat-input-row">
            <input
              className="chat-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send())}
              placeholder="Query the graph, recall memories, publish knowledge…"
            />
            <button className="chat-send" onClick={send}>Send</button>
          </div>
        </div>

        {/* Right panel — agent roster */}
        <div style={{ overflowY: 'auto', padding: '20px 18px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 14 }}>Active Agents</div>
          {AGENTS.map(a => (
            <div key={a.name} style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', marginBottom: 8, background: 'var(--surface)', cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: a.color, display: 'inline-block', boxShadow: a.status === 'active' ? `0 0 6px ${a.color}88` : 'none' }} />
                <span style={{ fontSize: 11, fontWeight: 600 }}>{a.name}</span>
                <span className="mono" style={{ marginLeft: 'auto', fontSize: 9, color: a.status === 'active' ? 'var(--green)' : a.status === 'pending' ? 'var(--amber)' : 'var(--text-dim)', textTransform: 'uppercase' }}>{a.status}</span>
              </div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>{a.tasks} task{a.tasks !== 1 ? 's' : ''} in queue</div>
            </div>
          ))}

          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 14, marginTop: 20 }}>Available Tools</div>
          {AGENT_TOOLS.map(t => (
            <div key={t} className="mono" style={{ fontSize: 10, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', marginBottom: 4, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--green)' }}>⚡</span>{t}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
