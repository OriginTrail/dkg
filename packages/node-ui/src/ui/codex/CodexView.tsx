import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MarkdownMessage } from '../components/chat/MarkdownMessage.js';
import { applyEvent, type Thread, type Item, type BridgeEvent } from './events.js';
import './codex.css';
import { MemoryReceipt, MemorySettings, type MemoryData } from './MemoryPanel.js';

async function call(path: string, body?: unknown) {
  const response = await fetch(`/api/codex/${path}`, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DKG-Codex': '1' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function MessageItem({ item, active, threadId }: { item: Item; active: boolean; threadId: string }) {
  if (item.type === 'userMessage') {
    return <div className="codex-user"><span>You</span><div>{(item.content ?? []).map((c: any) => c.text || (c.type === 'image' ? '[Image]' : '')).join('\n')}</div></div>;
  }
  if (item.type === 'agentMessage') return <div className={`codex-assistant ${item.phase === 'commentary' ? 'codex-commentary' : ''}`}><MarkdownMessage content={item.text || ''} streaming={active} localFileHref={(path) => `/api/codex/file?threadId=${encodeURIComponent(threadId)}&path=${encodeURIComponent(path)}`} /></div>;
  if (item.type === 'reasoning') {
    const text = (item.summary ?? []).map((s: any) => typeof s === 'string' ? s : s.text || '').join('\n');
    return text ? <details className="codex-tool"><summary>Reasoning summary</summary><MarkdownMessage content={text} /></details> : null;
  }
  if (item.type === 'contextCompaction') return <div className="codex-muted">Conversation context compacted</div>;
  const label = item.type === 'commandExecution' ? item.command
    : item.type === 'mcpToolCall' ? `${item.server} · ${item.tool}`
    : item.type === 'fileChange' ? `Files changed · ${(item.changes ?? []).map((c: any) => c.path.split('/').pop()).join(', ')}`
    : item.type === 'webSearch' ? `Search · ${item.query || item.action?.query || 'web'}`
    : item.type === 'dynamicToolCall' ? item.tool : item.type;
  const detail = item.aggregatedOutput || item.error?.message || (item.changes ? item.changes.map((c: any) => `${c.path}\n${c.diff ?? ''}`).join('\n') : '');
  return <details className="codex-tool"><summary><span>{label}</span><small>{item.status || ''}</small></summary>{detail ? <pre>{String(detail).slice(-100_000)}</pre> : <span className="codex-muted">{item.status === 'inProgress' ? 'Running…' : 'Completed'}</span>}</details>;
}

function RequestCard({ request, reply }: { request: any; reply: (id: string | number, response: unknown) => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [content, setContent] = useState('{}');
  const [formValues, setFormValues] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const p = request.params;
  const submit = async (response: unknown) => {
    setBusy(true); setError('');
    try { await reply(request.id, response); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const questions = request.method === 'item/tool/requestUserInput' ? p.questions : null;
  const elicitation = request.method === 'mcpServer/elicitation/request';
  const fields = Object.entries(p.requestedSchema?.properties ?? {}) as [string, any][];
  const complexForm = fields.some(([, schema]) => !['string', 'boolean', 'integer', 'number'].includes(schema.type));
  const permissions = request.method === 'item/permissions/requestApproval';
  const legacy = ['execCommandApproval', 'applyPatchApproval'].includes(request.method);
  const modernApproval = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method);
  const decisions = permissions ? ['accept', 'decline'] : legacy ? ['approved', 'denied', 'abort']
    : modernApproval ? (Array.isArray(p.availableDecisions) ? p.availableDecisions.filter((decision: unknown) => typeof decision === 'string')
      : ['accept', 'acceptForSession', 'decline', 'cancel']) : [];
  const decisionLabel: Record<string, string> = {
    accept: 'Allow once', acceptForSession: 'Allow for session', decline: 'Decline', cancel: 'Cancel',
    approved: 'Allow once', denied: 'Decline', abort: 'Cancel',
  };
  return <section className="codex-request" aria-label={questions ? 'Codex question' : 'Approval required'}>
    <strong>{questions ? 'Codex needs your input' : elicitation ? 'Additional information requested' : p.networkApprovalContext ? 'Network access approval required' : 'Approval required'}</strong>
    {p.reason && <p>{p.reason}</p>}
    {p.command && <pre>{Array.isArray(p.command) ? p.command.join(' ') : p.command}</pre>}
    {p.cwd && <div className="codex-muted">{p.cwd}</div>}
    {p.networkApprovalContext && <><p>Network destination</p><pre>{[
      `Host: ${p.networkApprovalContext.host ?? p.networkApprovalContext.targetHost ?? 'unknown'}`,
      `Protocol: ${p.networkApprovalContext.protocol ?? 'unknown'}`,
      p.networkApprovalContext.port === undefined ? null : `Port: ${p.networkApprovalContext.port}`,
    ].filter(Boolean).join('\n')}</pre></>}
    {permissions && <><p>Requested permissions (this turn only)</p><pre>{JSON.stringify(p.permissions, null, 2)}</pre></>}
    {p.additionalPermissions && <><p>Additional permissions requested</p><pre>{JSON.stringify(p.additionalPermissions, null, 2)}</pre></>}
    {p.grantRoot && <pre>{p.grantRoot}</pre>}
    {questions?.map((q: any) => <fieldset key={q.id}><legend>{q.question}</legend>
      {q.options?.map((o: any) => <label className="codex-option" key={o.label}><input type="radio" name={q.id} checked={answers[q.id] === o.label} onChange={() => setAnswers({ ...answers, [q.id]: o.label })} /><span>{o.label}<small>{o.description}</small></span></label>)}
      <input aria-label={q.question} type={q.isSecret ? 'password' : 'text'} placeholder="Your answer" value={answers[q.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
    </fieldset>)}
    {elicitation && <><p>{p.message}</p>{p.url && /^https?:\/\//i.test(p.url) && <a href={p.url} target="_blank" rel="noreferrer">Open requested page</a>}{complexForm ? <details><summary>Requested fields</summary><pre>{JSON.stringify(p.requestedSchema, null, 2)}</pre><textarea aria-label="Requested information as JSON" value={content} onChange={(e) => setContent(e.target.value)} /></details> : fields.map(([key, schema]) => <label key={key} className="codex-form-field">{schema.title || key}{schema.description && <small>{schema.description}</small>}{schema.enum ? <select aria-label={schema.title || key} value={formValues[key] ?? ''} onChange={(e) => setFormValues({ ...formValues, [key]: e.target.value })}><option value="">Choose…</option>{schema.enum.map((value: string) => <option key={value}>{value}</option>)}</select> : <input aria-label={schema.title || key} type={schema.type === 'boolean' ? 'checkbox' : ['integer', 'number'].includes(schema.type) ? 'number' : 'text'} value={schema.type === 'boolean' ? undefined : formValues[key] ?? ''} checked={schema.type === 'boolean' ? formValues[key] === true : undefined} onChange={(e) => setFormValues({ ...formValues, [key]: schema.type === 'boolean' ? e.target.checked : ['integer', 'number'].includes(schema.type) ? Number(e.target.value) : e.target.value })} />}</label>)}</>}
    {error && <p role="alert" className="codex-error">{error}</p>}
    <div className="codex-actions">
      {questions ? <button disabled={busy || questions.some((q: any) => !answers[q.id]?.trim())} onClick={() => submit({ answers: Object.fromEntries(questions.map((q: any) => [q.id, { answers: [answers[q.id]] }])) })}>Continue</button>
        : elicitation ? <><button disabled={busy} onClick={() => {
          if (elicitation) { try {
            const values = complexForm ? JSON.parse(content) : formValues;
            if ((p.requestedSchema?.required ?? []).some((key: string) => values[key] === undefined || values[key] === '')) { setError('Complete the required fields.'); return; }
            void submit({ action: 'accept', content: p.requestedSchema ? values : null });
          } catch { setError('Enter valid JSON.'); } }
        }}>{fields.length ? 'Submit' : 'Allow once'}</button><button disabled={busy} onClick={() => submit({ action: 'decline' })}>Decline</button><button disabled={busy} onClick={() => submit({ action: 'cancel' })}>Cancel</button></>
          : decisions.length ? decisions.map((decision: string) => <button key={decision} disabled={busy} onClick={() => submit({ decision })}>{decisionLabel[decision] ?? decision}</button>)
            : <span className="codex-muted">No decisions are available for this request.</span>}
    </div>
  </section>;
}

export function CodexView() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [thread, setThread] = useState<Thread | null>(null);
  const [memory, setMemory] = useState<MemoryData>({ settings: null, records: [] });
  const [status, setStatus] = useState<any>(null);
  const [pending, setPending] = useState<any[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeTurn, setActiveTurn] = useState<string | null>(null);
  const [externalActive, setExternalActive] = useState(false);
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [cwd, setCwd] = useState('');
  const [streamConnected, setStreamConnected] = useState(false);
  const [attachments, setAttachments] = useState<{ name: string; path: string }[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const stream = useRef<EventSource | null>(null);
  const selected = useRef('');
  const selectionVersion = useRef(0);
  const listVersion = useRef(0);
  const messageId = useRef<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const drafts = useRef<Record<string, string>>({});
  const completedTurns = useRef(new Set<string>());

  const loadList = useCallback(async (query = '', next?: string) => {
    const version = ++listVersion.current;
    const data = await call(`threads?search=${encodeURIComponent(query)}${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
    if (version !== listVersion.current) return;
    setThreads((old) => next ? [...old, ...data.data.filter((t: Thread) => !old.some((o) => o.id === t.id))] : data.data);
    setCursor(data.nextCursor ?? null);
  }, []);

  const connectEvents = useCallback((id: string, since: number) => {
    stream.current?.close();
    const source = new EventSource(`/api/codex/events?threadId=${encodeURIComponent(id)}&since=${since}`);
    stream.current = source;
    let opened = false;
    source.onopen = () => {
      if (selected.current !== id) return;
      setStreamConnected(true);
      if (opened) void call(`thread?id=${encodeURIComponent(id)}`).then((data) => {
        if (selected.current === id) { setThread(data.thread); setPending(data.pendingRequests); setActiveTurn(data.activeTurnId); if (data.memory) setMemory(data.memory); }
      }).catch((e) => setError(e.message));
      opened = true;
    };
    source.onerror = () => {
      if (selected.current !== id) return;
      setStreamConnected(false);
      // EventSource retries automatically. A restarted service requires the
      // owner-only launch URL to establish a new HttpOnly session.
    };
    source.onmessage = (message) => {
      if (selected.current !== id) return;
      const event: BridgeEvent = JSON.parse(message.data);
      if (event.method === 'memory/updated') setMemory((old) => ({ ...old, records: [...old.records.filter((r) => r.id !== event.params.record.id), event.params.record] }));
      setThread((old) => old ? applyEvent(old, event) : old);
      if (event.method === 'turn/started' && !completedTurns.current.has(event.params.turn.id)) setActiveTurn(event.params.turn.id);
      if (event.method === 'turn/completed') {
        completedTurns.current.add(event.params.turn.id);
        if (completedTurns.current.size > 1000) completedTurns.current.delete(completedTurns.current.values().next().value!);
        setActiveTurn(null); void loadList().catch(() => {});
      }
      if (event.method === 'bridge/request') setPending((old) => [...old.filter((r) => r.id !== event.params.id), event.params]);
      if (['bridge/requestResolved', 'serverRequest/resolved'].includes(event.method)) setPending((old) => old.filter((r) => String(r.id) !== String(event.params.requestId)));
      if (event.method === 'bridge/disconnected') { completedTurns.current.clear(); setActiveTurn(null); setPending([]); setError('Codex disconnected. Reopen the owner launch URL to reconnect. Your conversation is saved.'); }
      if (event.method === 'error' && event.params.error) setError(event.params.error.message);
    };
  }, [loadList]);

  const select = useCallback(async (id: string) => {
    const version = ++selectionVersion.current;
    setBusy(true); setError('');
    try {
      const data = await call('select', { threadId: id });
      if (version !== selectionVersion.current) return;
      selected.current = id; follow.current = true;
      setThread(data.thread); setPending(data.pendingRequests); setActiveTurn(data.activeTurnId);
      setMemory(data.memory || { settings: null, records: [] });
      setExternalActive(Boolean(data.externalActive));
      setDraft(drafts.current[id] || ''); messageId.current = null;
      setAttachments([]);
      connectEvents(id, data.sequence);
    } catch (e) { if (version === selectionVersion.current) setError((e as Error).message); }
    finally { if (version === selectionVersion.current) setBusy(false); }
  }, [connectEvents]);

  useEffect(() => {
    let cancelled = false;
    void call('status').then(async (data) => {
      if (cancelled) return;
      setStatus(data); setCwd(data.defaultCwd);
      await loadList();
      if (!cancelled && data.selectedThreadId) await select(data.selectedThreadId);
    }).catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; ++selectionVersion.current; stream.current?.close(); };
  }, [loadList, select]);
  useEffect(() => { if (follow.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }, [thread, pending]);
  useEffect(() => {
    if (!thread?.id) return;
    const id = thread.id;
    const timer = setInterval(() => { void call(`memory?threadId=${encodeURIComponent(id)}`).then((data) => {
      if (selected.current === id) setMemory(data);
    }).catch(() => {}); }, 5000);
    return () => clearInterval(timer);
  }, [thread?.id]);
  useEffect(() => {
    if (!externalActive || !thread?.id) return;
    const id = thread.id;
    const timer = setInterval(() => { void call(`thread?id=${encodeURIComponent(id)}`).then((data) => {
      if (selected.current === id) { setThread(data.thread); setExternalActive(Boolean(data.externalActive)); }
    }).catch(() => {}); }, 5000);
    return () => clearInterval(timer);
  }, [externalActive, thread?.id]);

  async function send() {
    if (!thread || (!draft.trim() && !attachments.length) || busy || activeTurn || externalActive) return;
    setBusy(true); setError('');
    const id = thread.id; const text = draft || 'Please examine the attached files.';
    messageId.current ||= crypto.randomUUID();
    try {
      const result = await call('send', { threadId: id, text, attachments, requestId: messageId.current });
      if (selected.current === id) { if (!completedTurns.current.has(result.turn.id)) setActiveTurn(result.turn.id); setDraft(''); setAttachments([]); drafts.current[id] = ''; messageId.current = null; follow.current = true; }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function create() {
    setBusy(true); setError('');
    try { const data = await call('new', { cwd }); setShowNew(false); await loadList(); await select(data.thread.id); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function attach(files: FileList | null) {
    if (!files?.length || !thread) return;
    const id = thread.id; setBusy(true); setError('');
    try {
      if (files.length + attachments.length > 4 || Array.from(files).some((f) => f.size > 4_000_000)) throw new Error('Attach up to four files, 4 MB each.');
      const encoded = await Promise.all(Array.from(files).map((file) => new Promise<{ name: string; base64: string }>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, base64: String(reader.result).split(',')[1] }); reader.onerror = () => reject(new Error('Could not read attachment.')); reader.readAsDataURL(file);
      })));
      const result = await call('attach', { threadId: id, files: encoded });
      if (selected.current === id) { setAttachments((old) => [...old, ...result.files]); messageId.current = null; }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  return <div className="codex-workspace">
    <aside className="codex-conversations">
      <div className="codex-heading"><strong>Conversations</strong><button title="New conversation" aria-label="New conversation" onClick={() => setShowNew(!showNew)}>＋</button></div>
      <form onSubmit={(e) => { e.preventDefault(); void loadList(search).catch((e) => setError(e.message)); }}><input type="search" aria-label="Search conversations" placeholder="Search conversations" value={search} onChange={(e) => setSearch(e.target.value)} /></form>
      {showNew && <div className="codex-new"><label>Workspace<input aria-label="Workspace folder" value={cwd} onChange={(e) => setCwd(e.target.value)} /></label><button disabled={busy} onClick={create}>Create conversation</button></div>}
      <div className="codex-conversation-list">{threads.map((t) => <button key={t.id} className={thread?.id === t.id ? 'selected' : ''} disabled={busy} onClick={() => select(t.id)}><span>{t.name || t.preview?.slice(0, 90) || 'New conversation'}</span><small>{t.cwd.split('/').filter(Boolean).at(-1)}</small></button>)}
        {cursor && <button onClick={() => loadList(search, cursor).catch((e) => setError(e.message))}>Load more</button>}
      </div>
      <div className="codex-account"><i className={status?.connected ? 'online' : ''} />{status?.requiresLogin ? 'Sign in through Codex' : status?.accountType === 'chatgpt' ? 'Connected with ChatGPT' : status ? 'Codex connected' : 'Connecting to Codex…'}</div>
    </aside>
    <main className="codex-main">
      <header className="codex-chat-header"><div><strong>{thread?.name || 'Codex'}</strong><small title={thread?.cwd}>{thread?.cwd || 'Your agent, connected to the DKG'}</small></div><span>{thread?.model || ''}</span></header>
      <MemorySettings data={memory} save={async (patch) => { const settings = await call('memory/settings', patch); setMemory((old) => ({ ...old, settings })); }} retry={async () => { await call('memory/retry', {}); const data = await call(`memory?threadId=${encodeURIComponent(thread?.id || '')}`); setMemory(data); }} />
      <div className="codex-messages" ref={scroll} onScroll={() => { const el = scroll.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
        {!thread && <div className="codex-welcome"><div className="codex-wordmark">Codex × DKG</div><h2>What shall we work on?</h2><p>Continue a conversation or start something new. Your node and context graphs are here alongside your work.</p><button onClick={() => setShowNew(true)}>New conversation</button></div>}
        {thread?.turns.map((turn) => <section key={turn.id}>{turn.items.map((item, index) => <React.Fragment key={item.id}><MessageItem item={item} threadId={thread.id} active={turn.id === activeTurn && index === turn.items.length - 1} />{memory.records.filter((r) => r.turnId === turn.id && (item.memoryRecordId ? r.id === item.memoryRecordId : r.itemId === item.id)).map((r) => <MemoryReceipt key={r.id} record={r} />)}</React.Fragment>)}{turn.status === 'failed' && <p className="codex-error">{turn.error?.message || 'This turn failed.'}</p>}{turn.status === 'interrupted' && <div className="codex-muted">Stopped</div>}</section>)}
        {activeTurn && <div className="codex-working"><i />Codex is working…</div>}
        {externalActive && <div className="codex-working"><i />This conversation is running in Codex. You can continue here when it finishes.</div>}
        {pending.map((request) => <RequestCard key={request.id} request={request} reply={async (id, response) => { await call('reply', { id, threadId: thread?.id, response }); setPending((old) => old.filter((r) => r.id !== id)); }} />)}
      </div>
      <div className="codex-compose">
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => void attach(e.target.files)} />
        {!!attachments.length && <div className="codex-attachments">{attachments.map((file) => <button key={file.path} onClick={() => setAttachments((old) => old.filter((f) => f.path !== file.path))} title="Remove attachment">{file.name} ×</button>)}</div>}
        {error && <div role="alert" className="codex-error">{error}<button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
        {thread && <><textarea aria-label="Message Codex" placeholder="Message Codex…" value={draft} rows={3} disabled={busy} onChange={(e) => { setDraft(e.target.value); drafts.current[thread.id] = e.target.value; messageId.current = null; }} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
          <div className="codex-compose-footer"><button aria-label="Attach files to Codex" title="Attach files (up to 4 MB each)" disabled={busy || !!activeTurn || externalActive} onClick={() => fileInput.current?.click()}>＋</button><small>{externalActive ? 'Waiting for the active Codex turn to finish' : activeTurn ? 'Working · you can stop this reply' : streamConnected ? 'Enter to send · Shift+Enter for a new line' : 'Reconnecting…'}</small>{activeTurn ? <button onClick={() => call('stop', { threadId: thread.id }).catch((e) => setError(e.message))}>Stop</button> : <button className="codex-send" disabled={busy || externalActive || (!draft.trim() && !attachments.length) || !streamConnected} onClick={send}>{busy ? 'Starting…' : 'Send'}</button>}</div></>}
      </div>
    </main>
  </div>;
}
