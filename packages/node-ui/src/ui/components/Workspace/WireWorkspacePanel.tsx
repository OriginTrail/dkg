/**
 * WireWorkspacePanel — the post-create / post-join wire-up step.
 *
 * Reused by both CreateProjectModal (curator side, after manifest +
 * ontology publish) and JoinProjectModal (joiner side, after subscribe
 * + catchup). Both produce the same outcome: a workspace directory
 * containing the manifest's templated files (`.cursor/`, `.dkg/`,
 * `AGENTS.md`, optional `~/.claude/settings.json`) so the operator
 * can open the directory in their chosen coding tool and start
 * collaborating.
 *
 * Three states: input → previewed → installed. The operator must
 * preview before installing — this is the trust-building step that
 * shows exactly which files will land where, and surfaces the
 * installer's safety guards.
 *
 * Phase-8 polish (this file's recent rewrite):
 *   - Workspace path defaults are absolute (fetched from /api/host/info,
 *     never `~`-prefixed which the daemon rejects).
 *   - Agent URI is derived from the operator's wallet address (read-only
 *     in the panel) — `urn:dkg:agent:<wallet>`. The "nickname" field is
 *     a free-form human label that lands as rdfs:label / schema:name on
 *     the agent entity.
 *   - Environment dropdown picks among Cursor / Claude Code / Both
 *     today; Codex is listed as "coming soon" (visible but disabled).
 */
import React, { useState, useEffect, useMemo } from 'react';
import { authHeaders, fetchCurrentAgent } from '../../api.js';
import {
  planProjectManifestInstall,
  installProjectManifest,
  type PlanInstallResult,
  type InstallResult,
} from '../../lib/projectManifest.js';

interface WireWorkspacePanelProps {
  /** Context graph ID — used to call /api/context-graph/{id}/manifest/* . */
  contextGraphId: string;
  /** Display name for the project — drives the default workspace dir name. */
  projectName?: string;
  /** Default agent nickname (e.g. "Brana laptop 1"). Operator can override. */
  defaultAgentNickname?: string;
  /** Called when the operator finishes installing or skips. */
  onDone: () => void;
  /** Called when the operator clicks Cancel before doing anything. */
  onCancel?: () => void;
  /** Tone variant — "create" pitches it as "wire your own workspace", "join" pitches it as "wire the project locally". */
  variant: 'create' | 'join';
}

const WORKSPACE_PARENT_KEY = 'dkg.wireWorkspace.parentDir';
const NICKNAME_KEY = 'dkg.wireWorkspace.nickname';
const TOOLS_KEY = 'dkg.wireWorkspace.tools';

interface HostInfo {
  homedir: string;
  hostname: string;
  username: string;
  platform: string;
  defaultWorkspaceParent: string;
}

interface AgentIdentity {
  agentAddress: string;
  agentDid: string;
  name: string;
}

type ToolSelection = 'cursor' | 'claude-code' | 'both';

interface ToolOption {
  value: ToolSelection;
  label: string;
  description: string;
  disabled?: boolean;
  comingSoon?: boolean;
}

const TOOL_OPTIONS: ToolOption[] = [
  {
    value: 'cursor',
    label: 'Cursor',
    description: 'Wires .cursor/mcp.json + hooks + rules into the workspace.',
  },
  {
    value: 'claude-code',
    label: 'Claude Code',
    description: 'Merges hooks into ~/.claude/settings.json. Requires Claude Code installed.',
  },
  {
    value: 'both',
    label: 'Both Cursor and Claude Code',
    description: 'Wires both tools so either can operate on this project.',
  },
  {
    value: 'cursor', // dummy, disabled
    label: 'Codex (coming soon)',
    description: "Codex CLI integration isn't shipped yet — pick another tool for now.",
    disabled: true,
    comingSoon: true,
  },
];

function projectDirSlug(name: string | undefined, contextGraphId: string): string {
  // The CG ID is `<address>/<slug>`; pick the slug for a friendlier dir name.
  const parts = contextGraphId.split('/');
  const tail = parts[parts.length - 1] ?? '';
  if (tail) return tail;
  return (name ?? 'project')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function defaultNicknameFromHost(host: HostInfo | null): string {
  if (!host) return '';
  // Pleasant default: "<username>@<hostname-stripped>" e.g. "alice@MacBook-Pro".
  // Operators almost always edit this to something like "Alice on laptop 1".
  const host_short = host.hostname
    .replace(/\.local$/, '')
    .replace(/-/g, ' ');
  return `${host.username} @ ${host_short}`;
}

function selectedTools(sel: ToolSelection): ('cursor' | 'claude-code')[] {
  if (sel === 'both') return ['cursor', 'claude-code'];
  return [sel];
}

export function WireWorkspacePanel({
  contextGraphId,
  projectName,
  defaultAgentNickname,
  onDone,
  onCancel,
  variant,
}: WireWorkspacePanelProps) {
  const slug = useMemo(() => projectDirSlug(projectName, contextGraphId), [projectName, contextGraphId]);
  const [host, setHost] = useState<HostInfo | null>(null);
  const [agent, setAgent] = useState<AgentIdentity | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [nickname, setNickname] = useState('');
  const [toolSelection, setToolSelection] = useState<ToolSelection>('cursor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planResult, setPlanResult] = useState<PlanInstallResult | null>(null);
  const [installResult, setInstallResult] = useState<InstallResult | null>(null);

  // Fetch host info + identity on mount so the defaults land sensibly.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [hostRes, agentRes] = await Promise.all([
          fetch('/api/host/info', { headers: authHeaders() }).then(r => r.ok ? r.json() : null),
          fetchCurrentAgent().catch(() => null),
        ]);
        if (cancelled) return;
        if (hostRes) {
          setHost(hostRes);
          const parent = (typeof window !== 'undefined' && window.localStorage.getItem(WORKSPACE_PARENT_KEY))
            || hostRes.defaultWorkspaceParent;
          setWorkspaceRoot(`${parent}/${slug}`);
        }
        if (agentRes) setAgent(agentRes as AgentIdentity);
        // Restore nickname / tool choice from prior wire if available.
        const savedNick = typeof window !== 'undefined' && window.localStorage.getItem(NICKNAME_KEY);
        if (defaultAgentNickname) setNickname(defaultAgentNickname);
        else if (savedNick) setNickname(savedNick);
        else if (hostRes) setNickname(defaultNicknameFromHost(hostRes));
        const savedTools = typeof window !== 'undefined' && window.localStorage.getItem(TOOLS_KEY) as ToolSelection | null;
        if (savedTools && (savedTools === 'cursor' || savedTools === 'claude-code' || savedTools === 'both')) {
          setToolSelection(savedTools);
        }
      } catch (err) {
        // Non-fatal — operator just has to fill the path themselves.
        if (!cancelled) console.warn('[WireWorkspacePanel] host info / identity fetch failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [slug, defaultAgentNickname]);

  function rememberPrefs(parentDir: string) {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(WORKSPACE_PARENT_KEY, parentDir);
    if (nickname) window.localStorage.setItem(NICKNAME_KEY, nickname);
    window.localStorage.setItem(TOOLS_KEY, toolSelection);
  }

  async function handlePreview() {
    setBusy(true);
    setError(null);
    try {
      const expanded = workspaceRoot.trim();
      if (!expanded || expanded.startsWith('~')) {
        throw new Error('Workspace path must be an absolute path (start with `/`). The daemon will create the directory if it does not exist.');
      }
      const result = await planProjectManifestInstall(contextGraphId, {
        workspaceRoot: expanded,
        agentNickname: nickname.trim(),
        tools: selectedTools(toolSelection),
      } as any);
      setPlanResult(result);
      const lastSlash = expanded.lastIndexOf('/');
      if (lastSlash > 0) rememberPrefs(expanded.slice(0, lastSlash));
    } catch (err: any) {
      setError(err?.message || 'Preview failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleInstall() {
    setBusy(true);
    setError(null);
    try {
      const expanded = workspaceRoot.trim();
      const result = await installProjectManifest(contextGraphId, {
        workspaceRoot: expanded,
        agentNickname: nickname.trim(),
        tools: selectedTools(toolSelection),
      } as any);
      setInstallResult(result);
    } catch (err: any) {
      setError(err?.message || 'Install failed');
    } finally {
      setBusy(false);
    }
  }

  // ── Installed state — success card ──
  if (installResult) {
    return (
      <div>
        <div style={{
          padding: '12px 14px', borderRadius: 8, marginBottom: 14, fontSize: 12,
          background: 'rgba(34, 197, 94, 0.08)', border: '1px solid rgba(34, 197, 94, 0.25)',
          color: 'var(--accent-green)',
        }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Workspace wired.</div>
          Open <code style={{ fontFamily: 'var(--font-mono)' }}>{workspaceRoot}</code> in {toolSelection === 'claude-code' ? 'Claude Code' : (toolSelection === 'both' ? 'Cursor or Claude Code' : 'Cursor')}.
          On the first chat, your agent will see the project ontology
          {variant === 'join' ? ', tasks, and decisions' : ' you publish via dkg_add_task'}.
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
          Files written:
        </div>
        <pre style={{
          fontSize: 10, fontFamily: 'var(--font-mono)', maxHeight: 200, overflow: 'auto',
          padding: 10, borderRadius: 6, background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)', margin: 0,
        }}>
          {installResult.written.map((w) => `${w.action.padEnd(9)} ${w.absPath} (${w.bytesWritten.toLocaleString()} bytes)`).join('\n')}
          {installResult.skipped.length ? '\n\nSkipped:\n' + installResult.skipped.map((s) => `  - ${s}`).join('\n') : ''}
          {installResult.warnings.length ? '\n\nWarnings:\n' + installResult.warnings.map((w) => `  - ${w}`).join('\n') : ''}
        </pre>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="v10-modal-btn primary" onClick={onDone}>Done</button>
        </div>
      </div>
    );
  }

  // ── Previewed state — show the diff + install button ──
  if (planResult) {
    return (
      <div>
        {error && <div className="v10-modal-error" style={{ marginBottom: 12 }}>{error}</div>}

        <div style={{ marginBottom: 10, fontSize: 11, color: 'var(--text-secondary)' }}>
          Review the install plan. Files are only written when you click Install.
        </div>

        <pre style={{
          fontSize: 10, fontFamily: 'var(--font-mono)', maxHeight: 320, overflow: 'auto',
          padding: 12, borderRadius: 6, background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)', margin: 0, whiteSpace: 'pre-wrap',
        }}>
          {planResult.markdown}
        </pre>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, gap: 10 }}>
          <button
            className="v10-modal-btn"
            onClick={() => { setPlanResult(null); setError(null); }}
            disabled={busy}
          >
            ← Back
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="v10-modal-btn" onClick={onDone} disabled={busy}>Skip for now</button>
            <button
              className="v10-modal-btn primary"
              onClick={handleInstall}
              disabled={busy}
            >
              {busy ? 'Installing…' : 'Install'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Input state ──
  const toolDescription = TOOL_OPTIONS.find(t => t.value === toolSelection && !t.disabled)?.description
    ?? TOOL_OPTIONS[0].description;

  return (
    <div>
      <div style={{
        padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 12,
        background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.25)',
        color: 'var(--accent-primary, #3b82f6)',
      }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          {variant === 'create' ? 'Wire your local workspace' : 'Wire this project locally'}
        </div>
        {variant === 'create'
          ? 'Choose a directory for the new project and which coding tool you want it wired for. The daemon will populate the workspace with the right config files so your agent can join the project from turn one.'
          : 'Choose a local directory for this project and which coding tool you want it wired for. The daemon will populate the workspace with the right config files so your agent can collaborate on this project.'}
      </div>

      {error && <div className="v10-modal-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="v10-form-group">
        <label className="v10-form-label">Workspace path</label>
        <input
          className="v10-form-input"
          type="text"
          value={workspaceRoot}
          onChange={(e) => setWorkspaceRoot(e.target.value)}
          placeholder={host ? `${host.defaultWorkspaceParent}/${slug}` : '/Users/you/code/project'}
          spellCheck={false}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
        />
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 4 }}>
          Absolute path. Created if it doesn't exist. Daemon writes only inside this dir
          (plus optionally <code>~/.claude/settings.json</code> if Claude Code is selected).
          {host && <> Defaulted from your <code>$HOME</code> = <code>{host.homedir}</code>.</>}
        </div>
      </div>

      <div className="v10-form-group">
        <label className="v10-form-label">Coding tool to wire</label>
        <select
          className="v10-form-select"
          value={toolSelection}
          onChange={(e) => setToolSelection(e.target.value as ToolSelection)}
        >
          {TOOL_OPTIONS.map((opt, i) => (
            <option
              key={`${opt.label}-${i}`}
              value={opt.disabled ? '__disabled__' : opt.value}
              disabled={opt.disabled}
            >
              {opt.label}
            </option>
          ))}
        </select>
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 4 }}>
          {toolDescription}
        </div>
      </div>

      <div className="v10-form-group">
        <label className="v10-form-label">Your agent identity</label>
        <input
          className="v10-form-input"
          type="text"
          value={agent ? `urn:dkg:agent:${agent.agentAddress.toLowerCase()}` : 'fetching…'}
          disabled
          spellCheck={false}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 11, opacity: 0.75 }}
        />
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 4 }}>
          Cryptographic URI derived from this node's wallet address. Same on every project on this machine. Attribution
          (<code>prov:wasAttributedTo</code>) on every chat turn uses this URI.
        </div>
      </div>

      <div className="v10-form-group">
        <label className="v10-form-label">Nickname for this agent</label>
        <input
          className="v10-form-input"
          type="text"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="e.g. Alice on laptop 1"
          spellCheck={false}
          maxLength={80}
        />
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 4 }}>
          Free-form human label rendered as the agent's name in chips, lists, and rdfs:label triples.
          Doesn't affect attribution — only changes how you appear to others.
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, gap: 10 }}>
        {onCancel
          ? <button className="v10-modal-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          : <button className="v10-modal-btn" onClick={onDone} disabled={busy}>Skip for now</button>}
        <button
          className="v10-modal-btn primary"
          onClick={handlePreview}
          // NOTE: we deliberately DO NOT gate on `!agent`. The backend
          // derives `agentUri` from the bearer token during
          // `plan-install`/`install`, so a transient failure of
          // `/api/agent/current` (reverse-proxy flake, daemon restart,
          // keystore rehydration race) must not lock the panel — the
          // install can still succeed, and the identity read is purely
          // informational (used to display the wallet address for
          // confirmation). Gating on it caused day-4 QA to report the
          // panel "hanging" whenever identity fetch retried slowly.
          disabled={busy || !workspaceRoot.trim() || !nickname.trim()}
        >
          {busy ? 'Loading preview…' : 'Preview install'}
        </button>
      </div>
    </div>
  );
}
