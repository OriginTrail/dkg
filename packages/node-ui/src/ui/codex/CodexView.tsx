import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MarkdownMessage } from '../components/chat/MarkdownMessage.js';
import { type Thread, type Item } from './events.js';
import './codex.css';
import { MemoryReceipt, MemorySettings, type MemoryData } from './MemoryPanel.js';
import { callCodex as call } from './api.js';
import { useCodexSession } from './useCodexSession.js';

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
  const p = request.details ?? {};
  const submit = async (response: unknown) => {
    setBusy(true); setError('');
    try { await reply(request.id, response); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const questions = request.kind === 'questions' ? p.questions : null;
  const elicitation = request.kind === 'elicitation';
  const fields = Object.entries(p.schema?.properties ?? {}) as [string, any][];
  const complexForm = fields.some(([, schema]) => !['string', 'boolean', 'integer', 'number'].includes(schema.type));
  const permissions = request.kind === 'permissions';
  const actions = Array.isArray(request.actions) ? request.actions : [];
  return <section className="codex-request" aria-label={questions ? 'Codex question' : 'Approval required'}>
    <strong>{request.title}</strong>
    {p.reason && <p>{p.reason}</p>}
    {p.command && <pre>{Array.isArray(p.command) ? p.command.join(' ') : p.command}</pre>}
    {p.cwd && <div className="codex-muted">{p.cwd}</div>}
    {p.network && <><p>Network destination</p><pre>{[
      `Host: ${p.network.host ?? p.network.targetHost ?? 'unknown'}`,
      `Protocol: ${p.network.protocol ?? 'unknown'}`,
      p.network.port === undefined ? null : `Port: ${p.network.port}`,
    ].filter(Boolean).join('\n')}</pre></>}
    {permissions && <><p>Requested permissions (this turn only)</p><pre>{JSON.stringify(p.permissions, null, 2)}</pre></>}
    {p.additionalPermissions && <><p>Additional permissions requested</p><pre>{JSON.stringify(p.additionalPermissions, null, 2)}</pre></>}
    {p.grantRoot && <pre>{p.grantRoot}</pre>}
    {questions?.map((q: any) => <fieldset key={q.id}><legend>{q.question}</legend>
      {q.options?.map((o: any) => <label className="codex-option" key={o.label}><input type="radio" name={q.id} checked={answers[q.id] === o.label} onChange={() => setAnswers({ ...answers, [q.id]: o.label })} /><span>{o.label}<small>{o.description}</small></span></label>)}
      <input aria-label={q.question} type={q.isSecret ? 'password' : 'text'} placeholder="Your answer" value={answers[q.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
    </fieldset>)}
    {elicitation && <><p>{p.message}</p>{p.url && /^https?:\/\//i.test(p.url) && <a href={p.url} target="_blank" rel="noreferrer">Open requested page</a>}{complexForm ? <details><summary>Requested fields</summary><pre>{JSON.stringify(p.schema, null, 2)}</pre><textarea aria-label="Requested information as JSON" value={content} onChange={(e) => setContent(e.target.value)} /></details> : fields.map(([key, schema]) => <label key={key} className="codex-form-field">{schema.title || key}{schema.description && <small>{schema.description}</small>}{schema.enum ? <select aria-label={schema.title || key} value={formValues[key] ?? ''} onChange={(e) => setFormValues({ ...formValues, [key]: e.target.value })}><option value="">Choose…</option>{schema.enum.map((value: string) => <option key={value}>{value}</option>)}</select> : <input aria-label={schema.title || key} type={schema.type === 'boolean' ? 'checkbox' : ['integer', 'number'].includes(schema.type) ? 'number' : 'text'} value={schema.type === 'boolean' ? undefined : formValues[key] ?? ''} checked={schema.type === 'boolean' ? formValues[key] === true : undefined} onChange={(e) => setFormValues({ ...formValues, [key]: schema.type === 'boolean' ? e.target.checked : ['integer', 'number'].includes(schema.type) ? Number(e.target.value) : e.target.value })} />}</label>)}</>}
    {error && <p role="alert" className="codex-error">{error}</p>}
    <div className="codex-actions">
      {questions ? <button disabled={busy || questions.some((q: any) => !answers[q.id]?.trim())} onClick={() => submit({ answers: Object.fromEntries(questions.map((q: any) => [q.id, { answers: [answers[q.id]] }])) })}>Continue</button>
        : elicitation ? <><button disabled={busy} onClick={() => {
          if (elicitation) { try {
            const values = complexForm ? JSON.parse(content) : formValues;
            if ((p.schema?.required ?? []).some((key: string) => values[key] === undefined || values[key] === '')) { setError('Complete the required fields.'); return; }
            void submit({ action: 'accept', content: p.schema ? values : null });
          } catch { setError('Enter valid JSON.'); } }
        }}>{fields.length ? 'Submit' : 'Allow once'}</button><button disabled={busy} onClick={() => submit({ action: 'decline' })}>Decline</button><button disabled={busy} onClick={() => submit({ action: 'cancel' })}>Cancel</button></>
          : actions.length ? actions.map((action: { id: string; label: string }) => <button key={action.id} disabled={busy} onClick={() => submit({ decision: action.id })}>{action.label}</button>)
            : <span className="codex-muted">No decisions are available for this request.</span>}
    </div>
  </section>;
}

function ConversationSidebar({
  threads, thread, busy, status, search, cursor, showNew, cwd,
  setSearch, setShowNew, setCwd, loadList, create, selectConversation, setError,
}: {
  threads: Thread[]; thread: Thread | null; busy: boolean; status: any; search: string;
  cursor: string | null; showNew: boolean; cwd: string;
  setSearch: (value: string) => void; setShowNew: (value: boolean) => void;
  setCwd: (value: string) => void; loadList: (query?: string, cursor?: string) => Promise<void>;
  create: () => Promise<void>; selectConversation: (id: string) => Promise<void>;
  setError: (error: string) => void;
}) {
  return <aside className="codex-conversations">
    <div className="codex-heading"><strong>Conversations</strong><button title="New conversation" aria-label="New conversation" onClick={() => setShowNew(!showNew)}>＋</button></div>
    <form onSubmit={(event) => { event.preventDefault(); void loadList(search).catch((error) => setError(error.message)); }}><input type="search" aria-label="Search conversations" placeholder="Search conversations" value={search} onChange={(event) => setSearch(event.target.value)} /></form>
    {showNew && <div className="codex-new"><label>Workspace<input aria-label="Workspace folder" value={cwd} onChange={(event) => setCwd(event.target.value)} /></label><button disabled={busy} onClick={create}>Create conversation</button></div>}
    <div className="codex-conversation-list">{threads.map((candidate) => <button key={candidate.id} className={thread?.id === candidate.id ? 'selected' : ''} disabled={busy} onClick={() => selectConversation(candidate.id)}><span>{candidate.name || candidate.preview?.slice(0, 90) || 'New conversation'}</span><small>{candidate.cwd.split('/').filter(Boolean).at(-1)}</small></button>)}
      {cursor && <button onClick={() => loadList(search, cursor).catch((error) => setError(error.message))}>Load more</button>}
    </div>
    <div className="codex-account"><i className={status?.connected ? 'online' : ''} />{status?.requiresLogin ? 'Sign in through Codex' : status?.accountType === 'chatgpt' ? 'Connected with ChatGPT' : status ? 'Codex connected' : 'Connecting to Codex…'}</div>
  </aside>;
}

function ConversationTimeline({
  thread, memory, pending, activeTurn, externalActive, scroll, follow, reply, startNew,
}: {
  thread: Thread | null; memory: MemoryData; pending: any[]; activeTurn: string | null;
  externalActive: boolean; scroll: React.RefObject<HTMLDivElement | null>;
  follow: React.MutableRefObject<boolean>;
  reply: (id: string | number, response: unknown) => Promise<void>; startNew: () => void;
}) {
  return <div className="codex-messages" ref={scroll} onScroll={() => { const element = scroll.current; if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
    {!thread && <div className="codex-welcome"><div className="codex-wordmark">Codex × DKG</div><h2>What shall we work on?</h2><p>Continue a conversation or start something new. Your node and context graphs are here alongside your work.</p><button onClick={startNew}>New conversation</button></div>}
    {thread?.turns.map((turn) => <section key={turn.id}>{turn.items.map((item, index) => <React.Fragment key={item.id}><MessageItem item={item} threadId={thread.id} active={turn.id === activeTurn && index === turn.items.length - 1} />{memory.records.filter((record) => record.turnId === turn.id && (item.memoryRecordId ? record.id === item.memoryRecordId : record.itemId === item.id)).map((record) => <MemoryReceipt key={record.id} record={record} />)}</React.Fragment>)}{turn.status === 'failed' && <p className="codex-error">{turn.error?.message || 'This turn failed.'}</p>}{turn.status === 'interrupted' && <div className="codex-muted">Stopped</div>}</section>)}
    {activeTurn && <div className="codex-working"><i />Codex is working…</div>}
    {externalActive && <div className="codex-working"><i />This conversation is running in Codex. You can continue here when it finishes.</div>}
    {pending.map((request) => <RequestCard key={request.id} request={request} reply={reply} />)}
  </div>;
}

function ConversationComposer({
  thread, attachments, draft, busy, activeTurn, externalActive, streamConnected, error,
  fileInput, setAttachments, setDraft, setError, attach, send, stop, draftChanged,
}: {
  thread: Thread | null; attachments: { name: string; path: string }[]; draft: string;
  busy: boolean; activeTurn: string | null; externalActive: boolean; streamConnected: boolean;
  error: string; fileInput: React.RefObject<HTMLInputElement | null>;
  setAttachments: React.Dispatch<React.SetStateAction<{ name: string; path: string }[]>>;
  setDraft: (draft: string) => void; setError: (error: string) => void;
  attach: (files: FileList | null) => Promise<void>; send: () => Promise<void>;
  stop: (threadId: string) => Promise<void>; draftChanged: (threadId: string, draft: string) => void;
}) {
  return <div className="codex-compose">
    <input ref={fileInput} type="file" multiple hidden onChange={(event) => void attach(event.target.files)} />
    {!!attachments.length && <div className="codex-attachments">{attachments.map((file) => <button key={file.path} onClick={() => setAttachments((old) => old.filter((candidate) => candidate.path !== file.path))} title="Remove attachment">{file.name} ×</button>)}</div>}
    {error && <div role="alert" className="codex-error">{error}<button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    {thread && <><textarea aria-label="Message Codex" placeholder="Message Codex…" value={draft} rows={3} disabled={busy} onChange={(event) => { setDraft(event.target.value); draftChanged(thread.id, event.target.value); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      <div className="codex-compose-footer"><button aria-label="Attach files to Codex" title="Attach files (up to 4 MB each)" disabled={busy || !!activeTurn || externalActive} onClick={() => fileInput.current?.click()}>＋</button><small>{externalActive ? 'Waiting for the active Codex turn to finish' : activeTurn ? 'Working · you can stop this reply' : streamConnected ? 'Enter to send · Shift+Enter for a new line' : 'Reconnecting…'}</small>{activeTurn ? <button onClick={() => stop(thread.id).catch((caught) => setError(caught.message))}>Stop</button> : <button className="codex-send" disabled={busy || externalActive || (!draft.trim() && !attachments.length) || !streamConnected} onClick={send}>{busy ? 'Starting…' : 'Send'}</button>}</div></>}
  </div>;
}

export function CodexView() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [cwd, setCwd] = useState('');
  const [attachments, setAttachments] = useState<{ name: string; path: string }[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const listVersion = useRef(0);
  const messageId = useRef<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const drafts = useRef<Record<string, string>>({});

  const loadList = useCallback(async (query = '', next?: string) => {
    const version = ++listVersion.current;
    const data = await call(`threads?search=${encodeURIComponent(query)}${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
    if (version !== listVersion.current) return;
    setThreads((old) => next ? [...old, ...data.data.filter((t: Thread) => !old.some((o) => o.id === t.id))] : data.data);
    setCursor(data.nextCursor ?? null);
  }, []);
  const session = useCodexSession(loadList);
  const {
    thread, memory, pending, activeTurn, externalActive, streamConnected,
    busy, error, select, setBusy, setError,
  } = session;

  const selectConversation = useCallback(async (id: string) => {
    follow.current = true;
    setDraft(drafts.current[id] || '');
    messageId.current = null;
    setAttachments([]);
    await select(id);
  }, [select]);

  useEffect(() => {
    let cancelled = false;
    void call('status').then(async (data) => {
      if (cancelled) return;
      setStatus(data); setCwd(data.defaultCwd);
      await loadList();
      if (!cancelled && data.selectedThreadId) await selectConversation(data.selectedThreadId);
    }).catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [loadList, selectConversation, setError]);
  useEffect(() => { if (follow.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }, [thread, pending]);

  async function send() {
    if (!thread || (!draft.trim() && !attachments.length) || busy || activeTurn || externalActive) return;
    setBusy(true); setError('');
    const id = thread.id; const text = draft || 'Please examine the attached files.';
    messageId.current ||= crypto.randomUUID();
    try {
      const result = await call('send', { threadId: id, text, attachments, requestId: messageId.current });
      if (session.isSelected(id)) { session.sendAcknowledged(id, result.turn.id); setDraft(''); setAttachments([]); drafts.current[id] = ''; messageId.current = null; follow.current = true; }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function create() {
    setBusy(true); setError('');
    try { const data = await call('new', { cwd }); setShowNew(false); await loadList(); await selectConversation(data.thread.id); }
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
      if (session.isSelected(id)) { setAttachments((old) => [...old, ...result.files]); messageId.current = null; }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  return <div className="codex-workspace">
    <ConversationSidebar {...{
      threads, thread, busy, status, search, cursor, showNew, cwd,
      setSearch, setShowNew, setCwd, loadList, create, selectConversation, setError,
    }} />
    <main className="codex-main">
      <header className="codex-chat-header"><div><strong>{thread?.name || 'Codex'}</strong><small title={thread?.cwd}>{thread?.cwd || 'Your agent, connected to the DKG'}</small></div><span>{thread?.model || ''}</span></header>
      <MemorySettings data={memory} save={async (patch) => { const settings = await call('memory/settings', patch); if (thread) session.setMemory(thread.id, { ...memory, settings }); }} retry={async () => { await call('memory/retry', {}); const data = await call(`memory?threadId=${encodeURIComponent(thread?.id || '')}`); if (thread) session.setMemory(thread.id, data); }} />
      <ConversationTimeline {...{ thread, memory, pending, activeTurn, externalActive, scroll, follow }} startNew={() => setShowNew(true)} reply={async (id, response) => { await call('reply', { id, threadId: thread?.id, response }); session.resolveRequest(id); }} />
      <ConversationComposer {...{
        thread, attachments, draft, busy, activeTurn, externalActive, streamConnected, error,
        fileInput, setAttachments, setDraft, setError, attach, send,
      }} stop={(threadId) => call('stop', { threadId })} draftChanged={(threadId, value) => { drafts.current[threadId] = value; messageId.current = null; }} />
    </main>
  </div>;
}
