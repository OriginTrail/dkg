/**
 * Design system reference — development only (see DESIGN.md).
 *
 * Every swatch, size and component on this page is rendered from the real
 * tokens (styles/00-theme.css) and the real components (components/ds), so
 * it can't drift from the app. Open it with `pnpm dev:ui`, then
 * http://127.0.0.1:5173/ui/design-system.html. `vite build` only bundles
 * index.html, so this page is not part of the released UI.
 */
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { Badge, Count, LayerBadge, type BadgeTone, LayerGlyph, StatusGlyph } from './components/ds/Badge.js';
import { Button, type ButtonVariant } from './components/ds/Button.js';
import { RetryButton } from './components/ds/RetryButton.js';
import { Toggle } from './components/ds/Toggle.js';
import { ContextGraphChip } from './components/ds/ContextGraphChip.js';
import { AgentChip, AgentTitle } from './components/AgentChip.js';
import { AgentDot, AgentDotStack } from './components/AgentDot.js';
import { agentColorForUri, type AgentSummary } from './hooks/useAgents.js';
import { BadgePercent, ChevronRight, Copy, RefreshCw, X } from 'lucide-react';
import { Loading } from './components/ds/Loading.js';
import { EmptyState } from './components/ContextGraphPrimitives.js';
import { StateMatrix } from './design-system-states.js';
import { PageHeader } from './components/ds/PageHeader.js';
import { Breadcrumbs } from './components/ds/Breadcrumbs.js';

type Theme = 'dark' | 'light';

function readTheme(): Theme {
  try { return localStorage.getItem('dkg-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}

function applyTheme(theme: Theme): void {
  for (const el of [document.documentElement, document.body]) el.classList.toggle('light', theme === 'light');
  try { localStorage.setItem('dkg-theme', theme); } catch { /* per-viewer convenience only */ }
}

function tokenValue(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ── Contrast (WCAG relative luminance) for text tokens ───────────────
function rgbOf(color: string): [number, number, number] | null {
  const probe = document.createElement('span');
  probe.style.color = color;
  document.body.appendChild(probe);
  const m = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g);
  probe.remove();
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : null;
}
function luminance([r, g, b]: [number, number, number]): number {
  const c = [r, g, b].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(fg: string, bg: string): number | null {
  const a = rgbOf(fg), b = rgbOf(bg);
  if (!a || !b) return null;
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ── Layout helpers ───────────────────────────────────────────────────
const Section: React.FC<{ id: string; title: string; lead?: React.ReactNode; children: React.ReactNode }> = ({ id, title, lead, children }) => (
  <section className="dsp-section" id={id}>
    <h2>{title}</h2>
    {lead ? <p className="dsp-lead">{lead}</p> : null}
    {children}
  </section>
);

const Row: React.FC<{ label: string; note?: React.ReactNode; children: React.ReactNode }> = ({ label, note, children }) => (
  <div className="dsp-row">
    <div className="dsp-row-label"><b>{label}</b>{note ? <span>{note}</span> : null}</div>
    <div className="dsp-row-items">{children}</div>
  </div>
);

const Swatch: React.FC<{ token: string; note?: string; on?: string; theme: Theme }> = ({ token, note, on, theme }) => {
  const [value, setValue] = useState('');
  const [ratio, setRatio] = useState<number | null>(null);
  useEffect(() => {
    setValue(tokenValue(token));
    setRatio(on ? contrast(`var(${token})`, `var(${on})`) : null);
  }, [token, on, theme]);
  return (
    <div className="dsp-swatch">
      <span className="dsp-chip" style={{ background: `var(${token})` }} />
      <span className="dsp-swatch-text">
        <code>{token}</code>
        <span className="dsp-muted">{value}{ratio ? ` · ${ratio.toFixed(1)}:1` : ''}</span>
        {note ? <span className="dsp-muted">{note}</span> : null}
      </span>
    </div>
  );
};

const Spec: React.FC<{ token: string; children: React.ReactNode }> = ({ token, children }) => (
  <div className="dsp-spec">{children}<code>{token}</code></div>
);

// ── Content ──────────────────────────────────────────────────────────
const LAYERS = [
  ['working', 'Working Memory · private drafts'],
  ['shared', 'Shared Working Memory · shared with the graph'],
  ['verified', 'Verifiable Memory · anchored on-chain'],
] as const;

const BADGE_TONES: Array<[BadgeTone, string]> = [
  ['neutral', 'Default fact'], ['muted', 'Secondary fact'], ['success', 'Done, healthy'],
  ['warning', 'Needs attention'], ['danger', 'Failed'], ['role', 'Your role, access'],
];

const BUTTONS: Array<[ButtonVariant, string, string]> = [
  ['primary', 'Create graph', 'The one main action in a view'],
  ['secondary', 'Import', 'Default'],
  ['ghost', 'Cancel', 'Low emphasis: toolbars, dismiss'],
  ['danger', 'Delete', 'Destructive: red outline, never a red fill'],
  ['swm', 'Share to SWM', 'Moves knowledge into Shared Memory'],
  ['vm', 'Publish to VM', 'The only purple fill: commits to Verifiable Memory'],
];

const SAMPLE_AGENT: AgentSummary = { uri: 'did:dkg:agent:0x7a3f', name: 'Claude Code', kind: 'ai', framework: 'claude-code', color: agentColorForUri('did:dkg:agent:0x7a3f') };

const App: React.FC = () => {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [tab, setTab] = useState('overview');
  const [seg, setSeg] = useState('agents');
  const [filters, setFilters] = useState<Record<string, boolean>>({ decisions: true, tasks: false });
  useEffect(() => { applyTheme(theme); }, [theme]);

  return (
    <div className="dsp">
      <style>{PAGE_CSS}</style>
      <header className="dsp-header">
        <div>
          <div className="dsp-kicker">Node UI · development reference</div>
          <h1>Design system</h1>
          <p className="dsp-lead">Rendered from the live tokens and components. Rules and reasoning are in <code>packages/node-ui/DESIGN.md</code>. Dark is the primary theme; check everything in both.</p>
        </div>
        <div className="ds-seg" role="group" aria-label="Theme">
          {(['dark', 'light'] as const).map((t) => (
            <button key={t} type="button" className="ds-seg-item" aria-pressed={theme === t} onClick={() => setTheme(t)}>{t === 'dark' ? 'Dark' : 'Light'}</button>
          ))}
        </div>
      </header>

      <nav className="dsp-toc" aria-label="Sections">
        {['Colour', 'Type', 'Shape', 'Buttons', 'Labels', 'Navigation', 'Things you open', 'Surfaces', 'Toggle', 'Icons', 'Feedback', 'Inputs', 'States'].map((s) => (
          <a key={s} href={`#${s.toLowerCase().replace(/\s+/g, '-')}`}>{s}</a>
        ))}
      </nav>

      <Section id="colour" title="Colour" lead="One hue, one job. Layer hues mean memory layers only; amber, green and red are signals only; purple fills exactly one button. Text ratios are against --bg-panel.">
        <Row label="Surfaces" note="darkest to lightest">
          {['--bg-root', '--bg-panel', '--bg-surface', '--bg-elevated', '--bg-hover', '--bg-active'].map((t) => <Swatch key={t} token={t} theme={theme} />)}
        </Row>
        <Row label="Borders">
          {['--border-subtle', '--border-default', '--border-strong', '--border-prominent'].map((t) => <Swatch key={t} token={t} theme={theme} />)}
        </Row>
        <Row label="Text" note="ghost is decoration only, never for reading">
          {['--text-primary', '--text-secondary', '--text-tertiary', '--text-ghost'].map((t) => <Swatch key={t} token={t} on="--bg-panel" theme={theme} />)}
        </Row>
        {LAYERS.map(([key, label]) => (
          <Row key={key} label={label.split(' · ')[0]} note={label.split(' · ')[1]}>
            <Swatch token={`--layer-${key}`} note="icon, dot, bar, underline" theme={theme} />
            <Swatch token={`--layer-${key}-text`} on={`--layer-${key}-bg`} note="text" theme={theme} />
            <Swatch token={`--layer-${key}-bg`} note="tint" theme={theme} />
            <Swatch token={`--layer-${key}-border`} note="outline" theme={theme} />
          </Row>
        ))}
        <Row label="Signals" note="state only, never identity">
          {['--text-success', '--text-warning', '--text-danger'].map((t) => <Swatch key={t} token={t} on="--bg-panel" theme={theme} />)}
        </Row>
        <Row label="Signal tints" note="notices, result cards, highlighted rows">
          {['success', 'warning', 'danger'].flatMap((s) => [`--${s}-bg`, `--${s}-bg-strong`, `--${s}-border`]).map((t) => <Swatch key={t} token={t} theme={theme} />)}
        </Row>
        <Row label="Neutral tints" note="hover rows, wells, tracks; read in both themes">
          {['--tint-faint', '--tint-subtle', '--tint-strong', '--shade'].map((t) => <Swatch key={t} token={t} theme={theme} />)}
        </Row>
        <Row label="Actions and focus">
          <Swatch token="--accent-primary" note="primary button" theme={theme} />
          <Swatch token="--accent-vm" note="Publish to VM only" theme={theme} />
          <Swatch token="--focus-ring" note="keyboard focus, ring only" theme={theme} />
        </Row>
        <Row label="Role and access" note="facts about you and the graph">
          {['--role', '--role-text', '--role-bg', '--role-border'].map((t) => <Swatch key={t} token={t} theme={theme} />)}
        </Row>
        <Row label="Data palette" note="fixed order, never cycled; also context graph colours">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <Swatch key={n} token={`--data-${n}`} theme={theme} />)}
        </Row>
      </Section>

      <Section id="type" title="Type" lead="Instrument Sans for the interface, JetBrains Mono for identifiers and code. Nothing below 10px.">
        {[
          ['--fs-display', 24, 600, 'Display · page totals'],
          ['--fs-heading', 18, 600, 'Heading · view titles'],
          ['--fs-title', 15, 600, 'Title · card and section titles'],
          ['--fs-body', 13, 400, 'Body · default reading text'],
          ['--fs-control', 12, 500, 'Control · buttons, tabs, inputs'],
          ['--fs-label', 11, 500, 'Label · badges, table headers'],
          ['--fs-micro', 10, 600, 'Micro · small badges, counts'],
        ].map(([token, px, weight, text]) => (
          <div className="dsp-type" key={token as string}>
            <code>{token} · {px}px</code>
            <span style={{ fontSize: `var(${token})`, fontWeight: weight as number }}>{text}</span>
          </div>
        ))}
        <div className="dsp-type"><code>--font-mono</code><span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-control)' }}>did:dkg:otp:20430/0x7a3f…b9a3</span></div>
      </Section>

      <Section id="shape" title="Shape" lead="The corner says what something is. Read-only facts are pills; things you click are rectangles.">
        <Row label="Corners">
          <Spec token="--radius-hair · 2"><span className="dsp-box" style={{ borderRadius: 'var(--radius-hair)' }}>Bar, track, swatch</span></Spec>
          <Spec token="--radius-xs · 4"><span className="dsp-box" style={{ borderRadius: 'var(--radius-xs)' }}>Menu row, segment</span></Spec>
          <Spec token="--radius-control · 6"><span className="dsp-box" style={{ borderRadius: 'var(--radius-control)' }}>Button, input, filter</span></Spec>
          <Spec token="--radius-nested · 8"><span className="dsp-box" style={{ borderRadius: 'var(--radius-nested)' }}>Inside a card, menu</span></Spec>
          <Spec token="--radius-card · 10"><span className="dsp-box" style={{ borderRadius: 'var(--radius-card)' }}>Card, panel</span></Spec>
          <Spec token="--radius-overlay · 12"><span className="dsp-box" style={{ borderRadius: 'var(--radius-overlay)' }}>Dialog, overlay</span></Spec>
          <Spec token="--radius-pill"><span className="dsp-box" style={{ borderRadius: 'var(--radius-pill)' }}>Badge, count, chip</span></Spec>
        </Row>
        <Row label="Elevation" note="one shadow per kind of surface">
          {[['--shadow-sm', 'Hovered card'], ['--shadow-menu', 'Menu, floating panel'], ['--shadow-popover', 'Popover'], ['--shadow-lift', 'Raised graph card'], ['--shadow-modal', 'Dialog'], ['--shadow-drawer', 'Side sheet']].map(([t, use]) => (
            <Spec key={t} token={t}><span className="dsp-box" style={{ boxShadow: `var(${t})`, borderRadius: 'var(--radius-nested)' }}>{use}</span></Spec>
          ))}
        </Row>
        <Row label="Heights" note="controls side by side share a height">
          <Spec token="--h-badge-sm · 18"><span className="dsp-bar" style={{ height: 'var(--h-badge-sm)' }} /></Spec>
          <Spec token="--h-badge-md · 22"><span className="dsp-bar" style={{ height: 'var(--h-badge-md)' }} /></Spec>
          <Spec token="--h-control-sm · 24"><span className="dsp-bar" style={{ height: 'var(--h-control-sm)' }} /></Spec>
          <Spec token="--h-control-md · 32"><span className="dsp-bar" style={{ height: 'var(--h-control-md)' }} /></Spec>
          <Spec token="--h-control-lg · 40"><span className="dsp-bar" style={{ height: 'var(--h-control-lg)' }} /></Spec>
        </Row>
      </Section>

      <Section id="buttons" title="Buttons" lead={<>One component: <code>{'<Button variant size icon>'}</code>. One primary per view.</>}>
        {BUTTONS.map(([variant, label, note]) => (
          <Row key={variant} label={variant} note={note}>
            <Button variant={variant} size="sm">{label}</Button>
            <Button variant={variant}>{label}</Button>
            <Button variant={variant} size="lg">{label}</Button>
            <Button variant={variant} disabled>{label}</Button>
          </Row>
        ))}
        <Row label="Icon" note="square; always give it an aria-label">
          <Button variant="ghost" icon size="sm" aria-label="Close"><X size={14} /></Button>
          <Button variant="ghost" icon aria-label="More">⋯</Button>
          <Button icon aria-label="Refresh"><RefreshCw size={14} /></Button>
        </Row>
      </Section>

      <Section id="labels" title="Labels" lead={<>Badges state a fact and are never the click target. <code>{'<Badge tone size dot icon>'}</code>, <code>{'<LayerBadge>'}</code>, <code>{'<Count>'}</code>.</>}>
        {BADGE_TONES.map(([tone, note]) => (
          <Row key={tone} label={tone} note={note}>
            <Badge tone={tone}>Label</Badge>
            <Badge tone={tone} dot>With dot</Badge>
            <Badge tone={tone} size="sm">Small</Badge>
          </Row>
        ))}
        <Row label="Layer" note="the one way to say which layer something is in">
          <LayerBadge layer="wm" /><LayerBadge layer="swm" /><LayerBadge layer="vm" /><LayerBadge layer="vm" size="sm" />
        </Row>
        <Row label="Kind" note="entity types: neutral pill, the kind's colour as a dot">
          <Badge tone="kind" kindColor="var(--data-1)">Decision</Badge>
          <Badge tone="kind" kindColor="var(--data-3)">Task</Badge>
        </Row>
        <Row label="Breadcrumbs" note="the way back from a deep view; top-level pages have none">
          <Breadcrumbs items={[{ label: 'Agent Context', onClick: () => undefined }, { label: 'Shared Working Memory' }]} />
        </Row>
        <Row label="PageHeader" note="the top of every page, inside ds-page: one h1, a description, an optional badge">
          <div style={{ width: '100%' }}><PageHeader title="Publisher Conviction" description="One line on what this page is for." badge={<Badge tone="role" size="sm">Node role: Core</Badge>} /></div>
        </Row>
        <Row label="Count" note="attention = needs your action (amber, never red)">
          <Count value={12} /><Count value={3} tone="attention" /><Count value={128} tone="quiet" />
        </Row>
      </Section>

      <Section id="navigation" title="Navigation" lead="Underline tabs say where you are. A segmented control switches what a panel shows. Filter chips are things you set.">
        <Row label="Tabs" note=".ds-tab, 12px, 2px underline">
          <div className="dsp-tabs" role="tablist">
            {['overview', 'entities', 'documents', 'query'].map((t) => (
              <button key={t} type="button" role="tab" className="ds-tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
            ))}
          </div>
        </Row>
        <Row label="Segmented" note=".ds-seg / .ds-seg-item, aria-pressed">
          <div className="ds-seg" role="group" aria-label="Panel">
            {['agents', 'network', 'sessions'].map((s) => (
              <button key={s} type="button" className="ds-seg-item" aria-pressed={seg === s} onClick={() => setSeg(s)}>{s[0].toUpperCase() + s.slice(1)}</button>
            ))}
          </div>
        </Row>
        <Row label="Filter chips" note=".ds-filter: a rectangle, never a pill">
          {Object.entries(filters).map(([f, on]) => (
            <button key={f} type="button" className="ds-filter" aria-pressed={on} onClick={() => setFilters({ ...filters, [f]: !on })}>{f[0].toUpperCase() + f.slice(1)} <Count value={on ? 8 : 3} tone="quiet" /></button>
          ))}
        </Row>
      </Section>

      <Section id="things-you-open" title="Things you open" lead="A leading mark says “this opens”: a tile for a context graph, a circle with initials for an agent.">
        <Row label="Context graph" note="<ContextGraphChip>">
          <ContextGraphChip id="cg:climate-science" name="Climate science" onOpen={() => undefined} />
          <ContextGraphChip id="cg:supply-chain-eu" name="EU supply chain" />
        </Row>
        <Row label="Agent" note="<AgentChip size>: 24 / 28 / 40. <AgentTitle> on an agent's own page">
          <AgentChip agent={SAMPLE_AGENT} size="sm" onOpenAgent={() => undefined} />
          <AgentChip agent={SAMPLE_AGENT} size="md" onOpenAgent={() => undefined} />
          <AgentChip agent={SAMPLE_AGENT} size="lg" onOpenAgent={() => undefined} />
          <AgentTitle agent={SAMPLE_AGENT} fallbackUri={SAMPLE_AGENT.uri} />
        </Row>
        <Row label="Agent avatars" note="<AgentDot>, <AgentDotStack>">
          <AgentDot uri="did:dkg:agent:0x7a3f" label="Claude Code" size={20} />
          <AgentDot uri="did:dkg:agent:0x19be" label="Hermes" size={24} />
          <AgentDotStack agents={['Ana Bevc', 'Hermes', 'Claude Code', 'Gemini', 'OpenClaw', 'Brana', 'Ops bot', 'Tijana'].map((l, i) => ({ uri: `did:dkg:agent:${i}`, label: l }))} max={5} />
        </Row>
      </Section>

      <Section id="surfaces" title="Surfaces" lead=".ds-overlay 12 for dialogs, .ds-card 10 for cards and panels, .ds-card-nested 8 for anything inside a card.">
        <div className="ds-overlay dsp-surface dsp-overlay">
          <b>Overlay · 12</b>
          <div className="ds-card dsp-surface">
            <b>Card · 10</b>
            <div className="dsp-nested-row">
              <div className="ds-card-nested dsp-surface dsp-nested"><span className="dsp-muted">Nested · 8</span><b>1,284</b></div>
              <div className="ds-card-nested dsp-surface dsp-nested"><span className="dsp-muted">Nested · 8</span><b>36</b></div>
            </div>
          </div>
        </div>
      </Section>

      <Section id="toggle" title="Toggle" lead="An on/off setting that takes effect straight away.">
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <Toggle checked={false} aria-label="Off example" />
          <Toggle checked aria-label="On example" />
          <Toggle checked busy aria-label="Saving example" />
        </div>
      </Section>

      <Section id="icons" title="Icons" lead="Lucide for actions and things, LayerGlyph for memory layers, StatusGlyph for status. One icon per job.">
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--fs-control)' }}>
          <span><X size={14} /> Close</span>
          <span><RefreshCw size={14} /> Refresh</span>
          <span><Copy size={14} /> Copy</span>
          <span><ChevronRight size={14} /> Expand</span>
          <span><BadgePercent size={14} /> Discount</span>
          <span><LayerGlyph layer="wm" /> Working</span>
          <span><LayerGlyph layer="swm" /> Shared</span>
          <span><LayerGlyph layer="vm" /> Verifiable</span>
          <span><StatusGlyph tone="success" /> Success</span>
          <span><StatusGlyph tone="warning" /> Warning</span>
          <span><StatusGlyph tone="danger" /> Danger</span>
          <span><StatusGlyph tone="pending" /> Pending</span>
        </div>
      </Section>

      <Section id="feedback" title="Feedback" lead="Loading, empty, error and disabled: one look each.">
        <div style={{ display: 'grid', gap: 12 }}>
          <Loading label="Loading peers…" />
          <EmptyState compact inline title="No active connections" description="Connections will appear here as your node links with peers." />
          <EmptyState compact tone="danger" title="Could not load peers" description="The node didn't respond." actions={[{ label: 'Retry', onClick: () => undefined }]} />
          <div><Button disabled>Disabled</Button></div>
        </div>
        <Row label="Retry · beside or below its message">
          <RetryButton onClick={() => undefined} />
          <RetryButton size="md" onClick={() => undefined} />
        </Row>
      </Section>

      <Section id="inputs" title="Inputs" lead="Same corners and heights as the buttons beside them; one focus ring.">
        <Row label="Default · 32">
          <input className="ds-input" placeholder="Search entities" aria-label="Search entities" />
          <select className="ds-input" aria-label="Sort"><option>Newest first</option><option>Name</option></select>
          <Button variant="primary">Search</Button>
        </Row>
        <Row label="Compact · 24">
          <input className="ds-input ds-sm" placeholder="Filter logs" aria-label="Filter logs" />
          <Button size="sm">Apply</Button>
        </Row>
        <Row label="Text area">
          <textarea className="ds-input dsp-textarea" placeholder="SELECT ?s ?p ?o WHERE { … }" aria-label="Query" />
        </Row>
      </Section>

      <Section id="states" title="States" lead="Every control in every state it has, in the theme chosen above. Hover and focus cells use the app's own rules. A dash means the control has no such state.">
        <StateMatrix />
      </Section>
    </div>
  );
};

// Page chrome only; uses tokens so it stays inside the rules it documents.
const PAGE_CSS = `
html, body { background: var(--bg-root); color: var(--text-primary); font-family: var(--font-sans); margin: 0; overflow: auto; height: auto; }
.dsp { max-width: 1120px; margin: 0 auto; padding: 32px 24px 80px; display: grid; gap: 40px; }
.dsp-header { display: flex; gap: 24px; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; }
.dsp h1 { font-size: var(--fs-display); margin: 4px 0 8px; }
.dsp h2 { font-size: var(--fs-heading); margin: 0; }
.dsp code { font-family: var(--font-mono); font-size: var(--fs-label); color: var(--text-secondary); }
.dsp-kicker { font-size: var(--fs-label); font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--text-tertiary); }
.dsp-lead { margin: 0; max-width: 72ch; color: var(--text-secondary); font-size: var(--fs-body); line-height: 1.55; }
.dsp-muted { color: var(--text-tertiary); font-size: var(--fs-label); }
.dsp-toc { display: flex; flex-wrap: wrap; gap: 4px 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border-default); position: sticky; top: 0; background: var(--bg-root); z-index: 2; padding-top: 12px; }
.dsp-toc a { color: var(--text-secondary); font-size: var(--fs-control); text-decoration: none; }
.dsp-toc a:hover { color: var(--text-primary); }
.dsp-section { display: grid; gap: 16px; scroll-margin-top: 56px; }
.dsp-row { display: grid; grid-template-columns: 200px 1fr; gap: 16px; align-items: start; padding: 12px 0; border-top: 1px solid var(--border-subtle); }
.dsp-row-label { display: grid; gap: 2px; font-size: var(--fs-body); }
.dsp-row-label span { color: var(--text-tertiary); font-size: var(--fs-label); }
.dsp-row-items { display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: center; min-width: 0; }
.dsp-swatch { display: flex; gap: 8px; align-items: center; min-width: 210px; }
.dsp-chip { width: 32px; height: 32px; border-radius: var(--radius-control); box-shadow: inset 0 0 0 1px var(--border-default); flex-shrink: 0; }
.dsp-swatch-text { display: grid; gap: 1px; }
.dsp-type { display: grid; grid-template-columns: 200px 1fr; gap: 16px; align-items: baseline; padding: 8px 0; border-top: 1px solid var(--border-subtle); }
.dsp-spec { display: grid; gap: 6px; justify-items: start; }
.dsp-box { display: inline-flex; align-items: center; height: var(--h-control-lg); padding: 0 14px; background: var(--bg-elevated); box-shadow: inset 0 0 0 1px var(--border-strong); font-size: var(--fs-control); }
.dsp-bar { display: block; width: 64px; background: var(--bg-active); border-radius: var(--radius-xs); box-shadow: inset 0 0 0 1px var(--border-strong); }
.dsp-tabs { display: flex; height: var(--tab-h); border-bottom: 1px solid var(--border-default); }
.dsp-surface { display: grid; gap: 12px; padding: 16px; background: var(--bg-surface); border: 1px solid var(--border-default); }
.dsp-overlay { background: var(--bg-elevated); max-width: 560px; }
.dsp-nested-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.dsp-nested { background: var(--bg-panel); gap: 4px; padding: 12px; }
.dsp-textarea { width: min(100%, 480px); min-height: 72px; padding: 8px 10px; font-family: var(--font-mono); }
.dsp-matrix { border-collapse: collapse; width: 100%; font-size: var(--fs-control); }
.dsp-matrix th { padding: 8px 12px 8px 0; text-align: left; font-weight: 500; color: var(--text-secondary); white-space: nowrap; }
.dsp-matrix thead th { font-size: var(--fs-label); color: var(--text-tertiary); }
.dsp-matrix tbody th { display: grid; gap: 2px; }
.dsp-matrix tbody th b { font-weight: 500; }
.dsp-matrix tbody th span { color: var(--text-tertiary); font-size: var(--fs-label); white-space: normal; max-width: 180px; }
.dsp-matrix td { padding: 8px 12px 8px 0; min-width: 120px; vertical-align: middle; }
.dsp-matrix tr { border-top: 1px solid var(--border-subtle); }
.dsp-matrix .ds-input { width: 112px; }
.dsp-none { color: var(--text-tertiary); }
@media (max-width: 720px) { .dsp-row, .dsp-type { grid-template-columns: 1fr; gap: 8px; } }
`;

applyTheme(readTheme());
createRoot(document.getElementById('root')!).render(<App />);
