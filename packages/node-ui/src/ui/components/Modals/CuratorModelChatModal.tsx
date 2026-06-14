import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  getModelGrant,
  invokeSharedModelChat,
  type SharedModelChatMessage,
} from '../../api.js';
import { useMyContextGraphs } from '../../hooks/useMyContextGraphs.js';
import { useModalDismiss } from './useModalDismiss.js';

interface CuratorModelChatModalProps {
  open: boolean;
  onClose: () => void;
}

/** A CG this node is a member of whose curator has model sharing enabled. */
interface AvailableSharedModel {
  contextGraphId: string;
  /** Friendly CG name, or the id when none is known. */
  label: string;
  modelId?: string;
}

/** One rendered chat line. `error` bubbles render a denial inline (no crash). */
interface ChatLine {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
}

/**
 * Curator Model — a MEMBER-side chat surface for the curator's shared AI model.
 *
 * Self-contained + self-discovering (mirrors ShareProjectModal's modal chrome,
 * but takes no contextGraphId — this is a CROSS-CG surface): it lists the
 * member's context graphs (useMyContextGraphs), reads each grant
 * (getModelGrant), and keeps the ones the curator has ENABLED. The member picks
 * one from a dropdown, then chats. Each send POSTs the running conversation to
 * the member node's OpenAI-compatible route via `invokeSharedModelChat`, which
 * runs the completion ON THE CURATOR'S node.
 *
 * Demo scope: in-memory session only (cleared when the selected model changes
 * or the modal closes), non-streaming single buffered reply, no tool-calls, no
 * persistence.
 */
export function CuratorModelChatModal({ open, onClose }: CuratorModelChatModalProps) {
  const { myCgs, cgsLoading } = useMyContextGraphs();

  const [available, setAvailable] = useState<AvailableSharedModel[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [selectedCg, setSelectedCg] = useState<string | null>(null);

  const [lines, setLines] = useState<ChatLine[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const { dialogRef, onBackdropClick } = useModalDismiss(open, onClose);

  // Discover shared models available to THIS node: for every CG the member
  // belongs to, read the grant and keep the ones the curator enabled. Re-runs
  // whenever the modal opens or the CG membership list changes. Failures per-CG
  // are swallowed (a CG whose grant can't be read simply isn't offered).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDiscovering(true);
    (async () => {
      const grants = await Promise.all(
        myCgs.map(async (cg) => {
          try {
            const grant = await getModelGrant(cg.id);
            if (!grant.enabled) return null;
            return {
              contextGraphId: cg.id,
              label: cg.name && cg.name.trim().length > 0 ? cg.name : cg.id,
              modelId: grant.modelId,
            } as AvailableSharedModel;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const enabled = grants.filter((g): g is AvailableSharedModel => g !== null);
      setAvailable(enabled);
      // Keep the current selection if it's still valid, else default to the
      // first available model.
      setSelectedCg((prev) =>
        prev && enabled.some((g) => g.contextGraphId === prev)
          ? prev
          : enabled[0]?.contextGraphId ?? null,
      );
      setDiscovering(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, myCgs]);

  // A fresh model = a fresh conversation (demo session is per-model, in-memory).
  useEffect(() => {
    setLines([]);
    setInput('');
  }, [selectedCg]);

  // Clear the in-memory session when the modal closes so re-opening starts clean.
  useEffect(() => {
    if (!open) {
      setLines([]);
      setInput('');
      setSending(false);
    }
  }, [open]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines, sending]);

  const selected = useMemo(
    () => available.find((g) => g.contextGraphId === selectedCg) ?? null,
    [available, selectedCg],
  );

  if (!open) return null;

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending || !selectedCg) return;

    const userLine: ChatLine = { id: `u-${Date.now()}`, role: 'user', content: text };
    // Build the running OpenAI-style message list from the prior turns (skip
    // error bubbles — they're UI-only and not part of the conversation) plus
    // this new user turn.
    const history: SharedModelChatMessage[] = lines
      .filter((l) => l.role === 'user' || l.role === 'assistant')
      .map((l) => ({ role: l.role as 'user' | 'assistant', content: l.content }));
    const outbound: SharedModelChatMessage[] = [...history, { role: 'user', content: text }];

    setLines((prev) => [...prev, userLine]);
    setInput('');
    setSending(true);
    try {
      const reply = await invokeSharedModelChat(selectedCg, outbound, {
        model: selected?.modelId,
      });
      setLines((prev) => [
        ...prev,
        { id: `a-${Date.now()}`, role: 'assistant', content: reply || '(empty reply)' },
      ]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Request failed';
      setLines((prev) => [
        ...prev,
        { id: `e-${Date.now()}`, role: 'error', content: message },
      ]);
    } finally {
      setSending(false);
    }
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="v10-modal-overlay" onClick={onBackdropClick} role="presentation">
      <div
        className="v10-modal-box"
        style={{ maxWidth: 620, display: 'flex', flexDirection: 'column', maxHeight: '85vh' }}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dkg-curator-model-modal-title"
      >
        <div
          className="v10-modal-header"
          style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div id="dkg-curator-model-modal-title" className="v10-modal-title">Curator Model</div>
            <div className="v10-modal-subtitle">
              Chat with an AI model a curator is sharing with you. The completion runs on the curator's node.
            </div>
          </div>
          <button
            type="button"
            className="v10-modal-close"
            onClick={onClose}
            aria-label="Close curator model dialog"
            title="Close (Esc)"
            style={{ flexShrink: 0, cursor: 'pointer' }}
          >
            ×
          </button>
        </div>

        <div className="v10-modal-body" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
          {/* Discovery / picker */}
          <div className="v10-form-group">
            <label className="v10-form-label" htmlFor="dkg-curator-model-select">Shared model</label>
            {discovering || cgsLoading ? (
              <div style={{
                padding: '8px 12px', borderRadius: 6, fontSize: 11,
                color: 'var(--text-tertiary)', background: 'var(--bg-surface)',
                border: '1px dashed var(--border-default)',
              }}>
                Discovering shared models…
              </div>
            ) : available.length === 0 ? (
              <div style={{
                padding: '8px 12px', borderRadius: 6, fontSize: 11,
                color: 'var(--text-tertiary)', background: 'var(--bg-surface)',
                border: '1px dashed var(--border-default)',
              }}>
                No curator is sharing a model with you yet.
              </div>
            ) : (
              <select
                id="dkg-curator-model-select"
                value={selectedCg ?? ''}
                onChange={(e) => setSelectedCg(e.target.value)}
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: 6, fontSize: 12,
                  background: 'var(--bg-surface)', color: 'var(--text-primary)',
                  border: '1px solid var(--border-default)', cursor: 'pointer',
                }}
              >
                {available.map((g) => (
                  <option key={g.contextGraphId} value={g.contextGraphId}>
                    {g.label}{g.modelId ? ` · ${g.modelId}` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* "Running on the curator's model" indicator */}
          {selected && (
            <div style={{
              marginBottom: 12, padding: '8px 10px', borderRadius: 6, fontSize: 11,
              color: 'var(--text-secondary)', background: 'var(--bg-surface)',
              border: '1px solid var(--accent-primary)',
            }}>
              Chatting on <strong>{selected.label}</strong>'s shared model
              {selected.modelId ? <> (<span style={{ fontFamily: 'var(--font-mono)' }}>{selected.modelId}</span>)</> : null}
              {' '}— runs on the curator's node.
            </div>
          )}

          {/* Message list */}
          {selected && (
            <div style={{
              flex: 1, minHeight: 160, overflowY: 'auto', display: 'flex', flexDirection: 'column',
              gap: 8, padding: '10px', borderRadius: 6, marginBottom: 10,
              background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
            }}>
              {lines.length === 0 && !sending && (
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center', margin: 'auto' }}>
                  Send a message to start chatting on the curator's model.
                </div>
              )}
              {lines.map((line) => (
                <div
                  key={line.id}
                  style={{
                    alignSelf: line.role === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '85%',
                    padding: '7px 10px', borderRadius: 8, fontSize: 12, lineHeight: 1.45,
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    background:
                      line.role === 'user'
                        ? 'var(--accent-primary)'
                        : line.role === 'error'
                          ? 'rgba(239, 68, 68, 0.12)'
                          : 'var(--bg-elevated, var(--bg-default))',
                    color:
                      line.role === 'user'
                        ? 'var(--text-on-accent)'
                        : line.role === 'error'
                          ? 'var(--text-danger)'
                          : 'var(--text-primary)',
                    border:
                      line.role === 'error'
                        ? '1px solid rgba(239, 68, 68, 0.3)'
                        : line.role === 'assistant'
                          ? '1px solid var(--border-default)'
                          : 'none',
                  }}
                >
                  {line.role === 'error' && (
                    <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', opacity: 0.8, marginBottom: 2 }}>
                      Denied
                    </div>
                  )}
                  {line.content}
                </div>
              ))}
              {sending && (
                <div style={{
                  alignSelf: 'flex-start', maxWidth: '85%', padding: '7px 10px', borderRadius: 8,
                  fontSize: 12, fontStyle: 'italic', color: 'var(--text-tertiary)',
                  background: 'var(--bg-elevated, var(--bg-default))', border: '1px solid var(--border-default)',
                }}>
                  thinking…
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
          )}

          {/* Composer */}
          {selected && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder="Message the curator's model… (Enter to send, Shift+Enter for newline)"
                rows={2}
                disabled={sending}
                aria-label="Message to the curator's shared model"
                style={{
                  flex: 1, resize: 'none', padding: '8px 10px', borderRadius: 6, fontSize: 12,
                  fontFamily: 'var(--font-body)', lineHeight: 1.45,
                  background: 'var(--bg-surface)', color: 'var(--text-primary)',
                  border: '1px solid var(--border-default)',
                }}
              />
              <button
                className="v10-modal-btn primary"
                onClick={() => void handleSend()}
                disabled={sending || input.trim().length === 0}
                style={{ cursor: sending || input.trim().length === 0 ? 'default' : 'pointer', height: 36 }}
              >
                {sending ? '…' : 'Send'}
              </button>
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
