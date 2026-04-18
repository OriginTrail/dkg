import React, { useState, useEffect } from 'react';
import { createContextGraph, fetchContextGraphs, fetchCurrentAgent } from '../../api.js';
import { useProjectsStore } from '../../stores/projects.js';
import { useTabsStore } from '../../stores/tabs.js';
import { useJourneyStore } from '../../stores/journey.js';
import { installOntology, listStarters } from '../../lib/ontologyInstall.js';

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

interface CreateProjectModalProps {
  open: boolean;
  onClose: () => void;
}

export function CreateProjectModal({ open, onClose }: CreateProjectModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [access, setAccess] = useState<'curated' | 'public'>('curated');
  const [publishPolicy, setPublishPolicy] = useState<'curator-only' | 'open'>('curator-only');
  const [ontology, setOntology] = useState<'agent' | 'upload' | 'community'>('community');
  // Which starter to install when ontology mode is 'community' (or 'agent' v1 default).
  // Source: packages/mcp-dkg/templates/ontologies/<slug>/ — bundled by Vite.
  const starters = listStarters();
  const [starterSlug, setStarterSlug] = useState<string>(starters[0]?.slug ?? 'coding-project');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [quorum, setQuorum] = useState('off');
  const [swmTtl, setSwmTtl] = useState('7d');
  const [swmCap, setSwmCap] = useState('100k');
  const [creating, setCreating] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [agentAddress, setAgentAddress] = useState<string | null>(null);

  const { setContextGraphs, contextGraphs, setActiveProject } = useProjectsStore();
  const { openTab } = useTabsStore();
  const { setStage, stage } = useJourneyStore();

  useEffect(() => {
    if (open) {
      fetchCurrentAgent()
        .then((a) => setAgentAddress(a.agentAddress))
        .catch(() => setAgentAddress(null));
    }
  }, [open]);

  if (!open) return null;

  const slug = slugify(name);
  const cgIdPreview = agentAddress && slug
    ? `${agentAddress}/${slug}`
    : slug ? `<agent-address>/${slug}` : '';

  const handleCreate = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;

    setCreating(true);
    setError(null);
    setProgress('Registering project on the network…');

    const finalSlug = slugify(trimmedName);
    const resolvedAddr = agentAddress ?? '0x0000000000000000000000000000000000000000';
    const cgId = `${resolvedAddr}/${finalSlug}`;

    try {
      const slowTimer = setTimeout(() => setProgress('On-chain registration in progress — this can take up to 30s…'), 5000);

      const opts = access === 'curated'
        ? { accessPolicy: 1, allowedAgents: agentAddress ? [agentAddress] : [] }
        : { accessPolicy: 0 };

      const result = await createContextGraph(cgId, trimmedName, description.trim() || undefined, opts);
      clearTimeout(slowTimer);

      // Phase 7: install the chosen ontology into meta/project-ontology so
      // the agent has the project's predicate vocabulary and URI patterns
      // from turn #1. Both `community` (operator picked a starter) and
      // `agent` (v1 = default to the closest starter; v2 will let the
      // agent customise based on the project description) install one
      // here. `upload` is deferred — the picker is disabled for that mode.
      if (ontology === 'community' || ontology === 'agent') {
        try {
          setProgress(`Installing '${starterSlug}' ontology…`);
          await installOntology(result.created, starterSlug);
        } catch (ontoErr: any) {
          // Don't roll back the CG — log the warning, surface a hint, and
          // let the operator re-run installation later if they want.
          console.warn('[CreateProjectModal] ontology install failed:', ontoErr);
          setProgress(`Project created, but ontology install failed: ${ontoErr?.message ?? ontoErr}`);
        }
      }

      setProgress('Refreshing project list…');
      const { contextGraphs: freshList } = await fetchContextGraphs();
      setContextGraphs(freshList ?? []);

      setActiveProject(result.created);
      openTab({ id: `project:${result.created}`, label: trimmedName, closable: true });
      if (stage < 2) setStage(2);

      setName('');
      setDescription('');
      setProgress('');
      onClose();
    } catch (err: any) {
      const msg = err?.message || 'Failed to create project';
      if (msg.includes('already exists') || msg.includes('409')) {
        setError('A project with this ID already exists. Try a different name.');
      } else if (msg.includes('taking longer')) {
        setError(msg);
      } else {
        setError(msg);
      }
      setProgress('');
    } finally {
      setCreating(false);
    }
  };

  const isFirstProject = contextGraphs.length === 0;

  return (
    <div className="v10-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v10-modal-box">
        <div className="v10-modal-header">
          <div className="v10-modal-title">Create New Project</div>
          <div className="v10-modal-subtitle">
            A project gives your agent structured memory — a place to draft, share, and publish knowledge.
          </div>
        </div>

        <div className="v10-modal-body">
          {error && (
            <div className="v10-modal-error">
              {error}
            </div>
          )}

          {isFirstProject && (
            <div className="v10-modal-tip">
              <div className="v10-modal-tip-title">First project tip</div>
              This is your agent's first memory space. Consider importing any existing knowledge
              your agent has — notes, documents, conversation logs — so it can build on what it already knows.
            </div>
          )}

          <div className="v10-form-group">
            <label className="v10-form-label">Project Name</label>
            <input
              className="v10-form-input"
              type="text"
              placeholder="e.g. Pharma Drug Interactions"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            {cgIdPreview && (
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                ID: did:dkg:context-graph:{cgIdPreview}
              </div>
            )}
          </div>

          <div className="v10-form-group">
            <label className="v10-form-label">Description</label>
            <textarea
              className="v10-form-textarea"
              placeholder="What should your agent remember? Describe the domain, goals, or context..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="v10-form-divider" />

          <div className="v10-form-group">
            <label className="v10-form-label">Access</label>
            <div className="v10-form-radio-group">
              <label className="v10-form-radio">
                <input type="radio" checked={access === 'curated'} onChange={() => setAccess('curated')} />
                Curated — only invited agents can participate
              </label>
              <label className="v10-form-radio">
                <input type="radio" checked={access === 'public'} onChange={() => setAccess('public')} />
                Public — anyone can view and join
              </label>
            </div>
          </div>

          <div className="v10-form-group" style={{ opacity: 0.5, pointerEvents: 'none' }}>
            <label className="v10-form-label">Publish Policy <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-tertiary)' }}>(coming soon)</span></label>
            <div className="v10-form-radio-group">
              <label className="v10-form-radio">
                <input type="radio" checked={publishPolicy === 'curator-only'} readOnly disabled />
                Curator only — only the curator can publish to Verified Memory
              </label>
              <label className="v10-form-radio">
                <input type="radio" checked={publishPolicy === 'open'} readOnly disabled />
                Open — any collaborator can publish to Verified Memory
              </label>
            </div>
          </div>

          <div className="v10-form-group">
            <label className="v10-form-label">Ontology</label>
            <div className="v10-form-radio-group">
              <label className="v10-form-radio">
                <input type="radio" checked={ontology === 'community'} onChange={() => setOntology('community')} />
                Choose a starter — install one of the bundled project-type ontologies
              </label>
              {ontology === 'community' && (
                <div style={{ marginLeft: 24, marginTop: 4, marginBottom: 8 }}>
                  <select
                    className="v10-form-select"
                    value={starterSlug}
                    onChange={(e) => setStarterSlug(e.target.value)}
                  >
                    {starters.map((s) => (
                      <option key={s.slug} value={s.slug}>{s.displayName}</option>
                    ))}
                  </select>
                  <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {starters.find((s) => s.slug === starterSlug)?.description}
                  </div>
                </div>
              )}
              <label className="v10-form-radio">
                <input type="radio" checked={ontology === 'agent'} onChange={() => setOntology('agent')} />
                Let agent decide — defaults to the closest starter (v1)
              </label>
              {ontology === 'agent' && (
                <div className="v10-form-radio-desc" style={{ marginLeft: 24, marginTop: 4, marginBottom: 8 }}>
                  v1 installs the <code>{starterSlug}</code> starter as a sensible default. A future
                  release will have the agent draft a project-specific ontology by extending the closest
                  starter from the project description.
                </div>
              )}
              <label className="v10-form-radio" style={{ opacity: 0.5 }}>
                <input type="radio" checked={ontology === 'upload'} onChange={() => setOntology('upload')} disabled />
                Upload an ontology file (.ttl, .owl, .rdf) <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-tertiary)' }}>(coming soon)</span>
              </label>
            </div>
          </div>

          <div className="v10-form-advanced-toggle" onClick={() => setShowAdvanced(!showAdvanced)}>
            <span className={`v10-form-adv-chevron ${showAdvanced ? 'open' : ''}`}>▸</span>
            <span>Advanced settings</span>
          </div>

          {showAdvanced && (
            <div className="v10-form-advanced-body" style={{ opacity: 0.5, pointerEvents: 'none' }}>
              <div className="v10-form-group">
                <label className="v10-form-label">Consensus Quorum <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-tertiary)' }}>(coming soon)</span></label>
                <select className="v10-form-select" value={quorum} disabled>
                  <option value="off">Off — no consensus verification required</option>
                  <option value="2of3">2 of 3 — lightweight consensus</option>
                  <option value="3of5">3 of 5 — standard consensus (recommended for teams)</option>
                  <option value="custom">Custom — set your own M of N</option>
                </select>
              </div>
              <div className="v10-form-group">
                <label className="v10-form-label">SWM TTL <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-tertiary)' }}>(coming soon)</span></label>
                <select className="v10-form-select" value={swmTtl} disabled>
                  <option value="7d">7 days (default)</option>
                  <option value="1h">1 hour</option>
                  <option value="1d">1 day</option>
                  <option value="30d">30 days</option>
                </select>
              </div>
              <div className="v10-form-group" style={{ marginBottom: 0 }}>
                <label className="v10-form-label">SWM Size Cap <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-tertiary)' }}>(coming soon)</span></label>
                <select className="v10-form-select" value={swmCap} disabled>
                  <option value="100k">100K triples (default)</option>
                  <option value="10k">10K triples</option>
                  <option value="1m">1M triples</option>
                </select>
              </div>
            </div>
          )}

        </div>

        <div className="v10-modal-footer">
          <button className="v10-modal-btn" onClick={onClose}>Cancel</button>
          <button
            className="v10-modal-btn primary"
            onClick={handleCreate}
            disabled={!name.trim() || creating}
          >
            {creating ? progress || 'Creating…' : 'Create Project'}
          </button>
        </div>
      </div>
    </div>
  );
}
