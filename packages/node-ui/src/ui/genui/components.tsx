/**
 * GenUI component implementations consumed by the OpenUI registry.
 *
 * Each component receives `{ props, renderNode }`:
 *   - `props` is the Zod-validated typed prop object from the LLM.
 *   - `renderNode(child)` renders nested OpenUI children (component refs,
 *     text, primitives). We only accept children on EntityDetail.
 *
 * Styling leans on existing `.v10-*` classes plus a small set of new
 * `.v10-genui-*` classes defined in styles.css.
 */
import React from 'react';

type RenderProps<P> = { props: P; renderNode: (value: unknown) => React.ReactNode };

/**
 * URL allow-list for anchors embedded in LLM-generated / graph-sourced GenUI.
 * Blocks `javascript:`, `data:`, `file:`, and other hostile schemes that would
 * otherwise execute when the user clicks an auto-rendered link. Returns the
 * URL itself for http(s) / mailto (relative URLs are let through unchanged),
 * and `null` for anything else so the caller can fall back to plain text.
 */
function safeHref(url: string | undefined | null): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    // `URL` throws on non-absolute inputs; treat those as relative and allow.
    const parsed = new URL(trimmed, 'https://placeholder.invalid');
    if (parsed.origin === 'https://placeholder.invalid') return trimmed; // relative URL
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
      return trimmed;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Root wrapper ──────────────────────────────────────────────
export const EntityDetailImpl: React.FC<RenderProps<{ title?: string; children?: unknown }>> = ({ props, renderNode }) => {
  const kids = (props as { children?: unknown }).children;
  return (
    <div className="v10-genui-root">
      {props.title ? <div className="v10-genui-root-title">{props.title}</div> : null}
      {Array.isArray(kids) ? kids.map((k, i) => <React.Fragment key={i}>{renderNode(k)}</React.Fragment>) : renderNode(kids)}
    </div>
  );
};

// ── EntityCard ────────────────────────────────────────────────
export const EntityCardImpl: React.FC<RenderProps<{
  name: string; typeLabel?: string; subtitle?: string;
  chips?: Array<{ label: string; value: string; tone?: 'default' | 'success' | 'warn' | 'danger' | 'info' }>;
}>> = ({ props }) => (
  <div className="v10-genui-card v10-genui-entity-card">
    <div className="v10-genui-card-head">
      <div className="v10-genui-card-title">{props.name}</div>
      {props.typeLabel ? <div className="v10-genui-card-type">{props.typeLabel}</div> : null}
    </div>
    {props.subtitle ? <div className="v10-genui-card-subtitle">{props.subtitle}</div> : null}
    {props.chips?.length ? (
      <div className="v10-genui-chips">
        {props.chips.map((c, i) => (
          <span key={i} className={`v10-genui-chip tone-${c.tone ?? 'default'}`}>
            <span className="v10-genui-chip-label">{c.label}</span>
            <span className="v10-genui-chip-value">{c.value}</span>
          </span>
        ))}
      </div>
    ) : null}
  </div>
);

// ── EntityStatsGrid ───────────────────────────────────────────
export const EntityStatsGridImpl: React.FC<RenderProps<{
  stats: Array<{ label: string; value: string | number; hint?: string }>;
}>> = ({ props }) => (
  <div className="v10-genui-stats-grid">
    {props.stats.map((s, i) => (
      <div key={i} className="v10-genui-stat" title={s.hint}>
        <div className="v10-genui-stat-value">{s.value}</div>
        <div className="v10-genui-stat-label">{s.label}</div>
      </div>
    ))}
  </div>
);

// ── TripleTable ───────────────────────────────────────────────
export const TripleTableImpl: React.FC<RenderProps<{
  heading?: string;
  rows: Array<{ predicate: string; object: string }>;
}>> = ({ props }) => (
  <div className="v10-genui-section">
    {props.heading ? <div className="v10-genui-section-heading">{props.heading}</div> : null}
    <div className="v10-genui-triple-table">
      {props.rows.map((r, i) => (
        <div key={i} className="v10-genui-triple-row">
          <div className="v10-genui-triple-predicate">{shortIri(r.predicate)}</div>
          <div className="v10-genui-triple-object">{shortValue(r.object)}</div>
        </div>
      ))}
    </div>
  </div>
);

// ── EntityTypeList ────────────────────────────────────────────
export const EntityTypeListImpl: React.FC<RenderProps<{
  heading?: string;
  groups: Array<{
    typeLabel: string;
    icon?: string;
    items: Array<{ label: string; uri?: string; sub?: string }>;
  }>;
}>> = ({ props }) => (
  <div className="v10-genui-section">
    {props.heading ? <div className="v10-genui-section-heading">{props.heading}</div> : null}
    <div className="v10-genui-type-groups">
      {props.groups.map((g, i) => (
        <div key={i} className="v10-genui-type-group">
          <div className="v10-genui-type-group-head">
            {g.icon ? <span className="v10-genui-type-icon">{g.icon}</span> : null}
            <span className="v10-genui-type-label">{g.typeLabel}</span>
            <span className="v10-genui-type-count">{g.items.length}</span>
          </div>
          <div className="v10-genui-type-items">
            {g.items.map((item, j) => (
              <div key={j} className="v10-genui-type-item" title={item.uri}>
                <div className="v10-genui-type-item-label">{item.label}</div>
                {item.sub ? <div className="v10-genui-type-item-sub">{item.sub}</div> : null}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  </div>
);

// ── CrossRefList ──────────────────────────────────────────────
export const CrossRefListImpl: React.FC<RenderProps<{
  heading: string;
  predicate?: string;
  items: Array<{ label: string; uri?: string; sub?: string }>;
}>> = ({ props }) => (
  <div className="v10-genui-section">
    <div className="v10-genui-section-heading">
      <span>{props.heading}</span>
      {props.predicate ? <span className="v10-genui-section-sub">· {shortIri(props.predicate)}</span> : null}
    </div>
    <div className="v10-genui-crossref">
      {props.items.map((item, i) => (
        <div key={i} className="v10-genui-crossref-item" title={item.uri}>
          <span className="v10-genui-crossref-label">{item.label}</span>
          {item.sub ? <span className="v10-genui-crossref-sub">{item.sub}</span> : null}
        </div>
      ))}
    </div>
  </div>
);

// ── PackageCard ───────────────────────────────────────────────
export const PackageCardImpl: React.FC<RenderProps<{
  name: string; folder?: string; description?: string;
  fileCount?: number; classCount?: number; functionCount?: number; interfaceCount?: number;
}>> = ({ props }) => (
  <div className="v10-genui-card v10-genui-package-card">
    <div className="v10-genui-card-head">
      <span className="v10-genui-card-icon" style={{ color: '#a855f7' }}>📦</span>
      <div className="v10-genui-card-title">{props.name}</div>
      {props.folder ? <div className="v10-genui-card-type">packages/{props.folder}</div> : null}
    </div>
    {props.description ? <div className="v10-genui-card-subtitle">{props.description}</div> : null}
    <div className="v10-genui-stats-grid">
      {typeof props.fileCount === 'number' && <MiniStat label="Files" value={props.fileCount} />}
      {typeof props.classCount === 'number' && <MiniStat label="Classes" value={props.classCount} />}
      {typeof props.functionCount === 'number' && <MiniStat label="Functions" value={props.functionCount} />}
      {typeof props.interfaceCount === 'number' && <MiniStat label="Interfaces" value={props.interfaceCount} />}
    </div>
  </div>
);

// ── FileCard ──────────────────────────────────────────────────
export const FileCardImpl: React.FC<RenderProps<{
  path: string; language?: string; lineCount?: number; packageName?: string;
}>> = ({ props }) => (
  <div className="v10-genui-card v10-genui-file-card">
    <div className="v10-genui-card-head">
      <span className="v10-genui-card-icon" style={{ color: '#3b82f6' }}>📄</span>
      <div className="v10-genui-card-title">{basename(props.path)}</div>
      {props.language ? <div className="v10-genui-card-type">.{props.language}</div> : null}
    </div>
    <div className="v10-genui-card-subtitle">{props.path}</div>
    <div className="v10-genui-chips">
      {props.packageName ? <span className="v10-genui-chip tone-info"><span className="v10-genui-chip-label">pkg</span><span className="v10-genui-chip-value">{props.packageName}</span></span> : null}
      {typeof props.lineCount === 'number' ? <span className="v10-genui-chip"><span className="v10-genui-chip-label">lines</span><span className="v10-genui-chip-value">{props.lineCount}</span></span> : null}
    </div>
  </div>
);

// ── DecisionCard ──────────────────────────────────────────────
export const DecisionCardImpl: React.FC<RenderProps<{
  title: string;
  status?: 'proposed' | 'accepted' | 'rejected' | 'superseded';
  date?: string;
  context?: string; outcome?: string; consequences?: string; alternatives?: string;
}>> = ({ props }) => (
  <div className="v10-genui-card v10-genui-decision-card">
    <div className="v10-genui-card-head">
      <span className="v10-genui-card-icon" style={{ color: '#ef4444' }}>◆</span>
      <div className="v10-genui-card-title">{props.title}</div>
      {props.status ? <div className={`v10-genui-status-chip status-${props.status}`}>{props.status}</div> : null}
    </div>
    {props.date ? <div className="v10-genui-card-subtitle">Decided {props.date}</div> : null}
    {props.context ? <DecisionSection heading="Context" body={props.context} /> : null}
    {props.outcome ? <DecisionSection heading="Outcome" body={props.outcome} /> : null}
    {props.consequences ? <DecisionSection heading="Consequences" body={props.consequences} /> : null}
    {props.alternatives ? <DecisionSection heading="Alternatives considered" body={props.alternatives} /> : null}
  </div>
);

// ── PRCard ────────────────────────────────────────────────────
export const PRCardImpl: React.FC<RenderProps<{
  title: string; number?: number; state?: 'open' | 'closed' | 'merged';
  author?: string; mergedAt?: string; body?: string; url?: string;
}>> = ({ props }) => (
  <div className="v10-genui-card v10-genui-pr-card">
    <div className="v10-genui-card-head">
      <span className="v10-genui-card-icon" style={{ color: '#f59e0b' }}>⇄</span>
      <div className="v10-genui-card-title">
        {typeof props.number === 'number' ? <span className="v10-genui-pr-num">#{props.number}</span> : null}
        {props.title}
      </div>
      {props.state ? <div className={`v10-genui-status-chip pr-state-${props.state}`}>{props.state}</div> : null}
    </div>
    <div className="v10-genui-chips">
      {props.author ? <span className="v10-genui-chip"><span className="v10-genui-chip-label">by</span><span className="v10-genui-chip-value">{props.author}</span></span> : null}
      {props.mergedAt ? <span className="v10-genui-chip tone-success"><span className="v10-genui-chip-label">merged</span><span className="v10-genui-chip-value">{props.mergedAt.split('T')[0]}</span></span> : null}
      {(() => {
        const href = safeHref(props.url);
        return href
          ? <a className="v10-genui-chip tone-info" href={href} target="_blank" rel="noopener noreferrer"><span className="v10-genui-chip-label">view</span><span className="v10-genui-chip-value">github</span></a>
          : null;
      })()}
    </div>
    {props.body ? <div className="v10-genui-pr-body">{props.body}</div> : null}
  </div>
);

// ── TaskCard ──────────────────────────────────────────────────
export const TaskCardImpl: React.FC<RenderProps<{
  title: string;
  status?: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
  priority?: 'p0' | 'p1' | 'p2' | 'p3';
  assignee?: string; estimate?: number;
}>> = ({ props }) => (
  <div className="v10-genui-card v10-genui-task-card">
    <div className="v10-genui-card-head">
      <span className="v10-genui-card-icon" style={{ color: '#06b6d4' }}>✓</span>
      <div className="v10-genui-card-title">{props.title}</div>
      {props.status ? <div className={`v10-genui-status-chip task-status-${props.status}`}>{props.status.replace('_', ' ')}</div> : null}
      {props.priority ? <div className={`v10-genui-priority-chip priority-${props.priority}`}>{props.priority.toUpperCase()}</div> : null}
    </div>
    <div className="v10-genui-chips">
      {props.assignee ? <span className="v10-genui-chip"><span className="v10-genui-chip-label">assignee</span><span className="v10-genui-chip-value">@{props.assignee}</span></span> : null}
      {typeof props.estimate === 'number' ? <span className="v10-genui-chip"><span className="v10-genui-chip-label">est</span><span className="v10-genui-chip-value">{props.estimate}h</span></span> : null}
    </div>
  </div>
);

// ── VerifiedProvenancePanel ───────────────────────────────────
export const VerifiedProvenancePanelImpl: React.FC<RenderProps<{
  onChain?: { txHash?: string; blockNumber?: string | number; chain?: string };
  consensus?: {
    signers?: Array<{ did: string; label?: string; reputation?: number; signature?: string }>;
    quorum?: string;
  };
  knowledgeAsset?: { ual?: string; contentHash?: string; tracLocked?: string; tokenId?: string };
  timeline?: Array<{ label: string; at: string }>;
}>> = ({ props }) => (
  <div className="v10-genui-vm-panel">
    <div className="v10-genui-vm-panel-head">
      <div className="v10-genui-vm-badge">
        <span className="v10-genui-vm-badge-dot" />
        Verified Memory
      </div>
      <div className="v10-genui-vm-title">On-chain provenance</div>
    </div>
    <div className="v10-genui-vm-grid">
      {props.onChain ? (
        <div className="v10-genui-vm-block">
          <div className="v10-genui-vm-block-heading">Anchoring</div>
          {props.onChain.txHash ? <ProvRow label="tx" value={shortHash(props.onChain.txHash)} mono /> : null}
          {props.onChain.blockNumber ? <ProvRow label="block" value={String(props.onChain.blockNumber)} mono /> : null}
          {props.onChain.chain ? <ProvRow label="chain" value={props.onChain.chain} /> : null}
        </div>
      ) : null}
      {props.consensus ? (
        <div className="v10-genui-vm-block">
          <div className="v10-genui-vm-block-heading">Consensus {props.consensus.quorum ? <span className="v10-genui-vm-quorum">{props.consensus.quorum}</span> : null}</div>
          {(props.consensus.signers ?? []).map((s, i) => (
            <div key={i} className="v10-genui-vm-signer">
              <div className="v10-genui-vm-signer-dot" />
              <div className="v10-genui-vm-signer-body">
                <div className="v10-genui-vm-signer-label">{s.label ?? shortDid(s.did)}</div>
                <div className="v10-genui-vm-signer-did">{s.did}</div>
              </div>
              {typeof s.reputation === 'number' ? <div className="v10-genui-vm-rep">rep {s.reputation}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
      {props.knowledgeAsset ? (
        <div className="v10-genui-vm-block">
          <div className="v10-genui-vm-block-heading">Knowledge asset</div>
          {props.knowledgeAsset.ual ? <ProvRow label="ual" value={props.knowledgeAsset.ual} mono /> : null}
          {props.knowledgeAsset.contentHash ? <ProvRow label="hash" value={shortHash(props.knowledgeAsset.contentHash)} mono /> : null}
          {props.knowledgeAsset.tracLocked ? <ProvRow label="trac" value={props.knowledgeAsset.tracLocked} /> : null}
          {props.knowledgeAsset.tokenId ? <ProvRow label="nft" value={`#${props.knowledgeAsset.tokenId}`} /> : null}
        </div>
      ) : null}
      {props.timeline?.length ? (
        <div className="v10-genui-vm-block">
          <div className="v10-genui-vm-block-heading">Timeline</div>
          {props.timeline.map((t, i) => (
            <div key={i} className="v10-genui-vm-timeline-row">
              <div className="v10-genui-vm-timeline-dot" />
              <div className="v10-genui-vm-timeline-label">{t.label}</div>
              <div className="v10-genui-vm-timeline-at">{t.at}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  </div>
);

// ── helpers ───────────────────────────────────────────────────
const MiniStat: React.FC<{ label: string; value: string | number }> = ({ label, value }) => (
  <div className="v10-genui-stat">
    <div className="v10-genui-stat-value">{value}</div>
    <div className="v10-genui-stat-label">{label}</div>
  </div>
);

const DecisionSection: React.FC<{ heading: string; body: string }> = ({ heading, body }) => (
  <div className="v10-genui-decision-section">
    <div className="v10-genui-decision-section-heading">{heading}</div>
    <div className="v10-genui-decision-section-body">{body}</div>
  </div>
);

const ProvRow: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="v10-genui-prov-row">
    <span className="v10-genui-prov-label">{label}</span>
    <span className={`v10-genui-prov-value${mono ? ' mono' : ''}`}>{value}</span>
  </div>
);

function shortIri(iri: string): string {
  const short = iri
    .replace(/^"|"$/g, '')
    .replace(/^<|>$/g, '')
    .replace('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'rdf:')
    .replace('http://www.w3.org/2000/01/rdf-schema#', 'rdfs:')
    .replace('http://www.w3.org/2001/XMLSchema#', 'xsd:')
    .replace('http://schema.org/', 'schema:')
    .replace('http://dkg.io/ontology/code/', 'code:')
    .replace('http://dkg.io/ontology/github/', 'gh:')
    .replace('http://dkg.io/ontology/decisions/', 'dec:')
    .replace('http://dkg.io/ontology/tasks/', 'task:')
    .replace('http://dkg.io/ontology/profile/', 'prof:');
  return short;
}

function shortValue(obj: string): string {
  return shortIri(obj).replace(/\^\^<?.*$/, '').replace(/^"(.+)"$/, '$1');
}

function shortHash(s: string): string {
  if (!s) return '';
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}

function shortDid(did: string): string {
  if (!did) return '';
  return did.length > 22 ? `${did.slice(0, 12)}…${did.slice(-6)}` : did;
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}
