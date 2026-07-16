import React, { useState, useEffect } from 'react';
import { createContextGraph, fetchContextGraphs, fetchCurrentAgent } from '../../api.js';
import { useProjectsStore } from '../../stores/projects.js';
import { useTabsStore } from '../../stores/tabs.js';
import { useJourneyStore } from '../../stores/journey.js';
import { installOntology, listStarters } from '../../lib/ontologyInstall.js';
import { publishProjectManifest } from '../../lib/projectManifest.js';
import { WireWorkspacePanel } from '../Workspace/WireWorkspacePanel.js';
import { useModalDismiss } from './useModalDismiss.js';
import { CG_NAME_MAX_LENGTH, sanitiseCgName, validateCgName } from './cgNameValidation.js';

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
  // Codex PR #608 R1/R2 #5/#8: registration is opt-in. Default OFF
  // so unfunded / offline / no-RPC users can still create a project
  // locally and register later from Settings when they have gas + a
  // working RPC. Verifiable Memory publish requires this to be on
  // (or registered later via the per-project Settings tab).
  const [registerOnChain, setRegisterOnChain] = useState<boolean>(false);
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
  const [registrationWarning, setRegistrationWarning] = useState<string | null>(null);
  const [agentAddress, setAgentAddress] = useState<string | null>(null);
  // Phase 8: after CG + ontology + manifest publish, transition into a
  // wire-workspace step so the curator can populate their own workspace
  // (and thus run the canonical V10 write flow — `dkg_assertion_create`
  // + `dkg_assertion_write` + `dkg_assertion_promote` — from their own
  // Cursor agent) without dropping to the terminal. `wiredCgId` flips the modal body
  // into the WireWorkspacePanel; `wiredProjectName` lets the panel
  // suggest a default workspace path like `~/code/<projectSlug>`.
  const [wiredCgId, setWiredCgId] = useState<string | null>(null);
  const [wiredProjectName, setWiredProjectName] = useState<string>('');
  // Agent-identity load state drives the Retry affordance + the Create
  // button copy; added on v10-rc alongside the private-CG fix so the
  // modal degrades gracefully when /api/agent/current 401s during boot.
  // Start in the loading state: the modal always kicks off an identity
  // fetch on open (see effect below), and the fetch is dispatched from an
  // effect that runs AFTER the first paint. Seeding `true` avoids a single
  // frame where the button would otherwise read "Agent unavailable". (F4)
  const [identityLoading, setIdentityLoading] = useState(true);
  const [identityError, setIdentityError] = useState(false);

  const { setContextGraphs, contextGraphs, setActiveProject } = useProjectsStore();
  const { openTab } = useTabsStore();
  const { setStage, stage } = useJourneyStore();

  const loadAgentIdentity = () => {
    setIdentityLoading(true);
    setIdentityError(false);
    fetchCurrentAgent()
      .then((a) => { setAgentAddress(a.agentAddress); setIdentityError(false); })
      .catch(() => { setAgentAddress(null); setIdentityError(true); })
      .finally(() => setIdentityLoading(false));
  };

  useEffect(() => {
    if (open) {
      setRegistrationWarning(null);
      loadAgentIdentity();
    }
  }, [open]);

  const wireDismiss = useModalDismiss(open && !wiredCgId, onClose);
  const wiredDismiss = useModalDismiss(open && !!wiredCgId, () => {
    setWiredCgId(null);
    setWiredProjectName('');
    setRegistrationWarning(null);
    setName('');
    setDescription('');
    onClose();
  });

  if (!open) return null;

  // Store the raw user input verbatim so `validateCgName(name)` can
  // see and surface every warning the helper emits (stripped HTML
  // tags, over-length, slug-empty). The cleaned form is derived for
  // the submit path and the slug preview only.
  const cleanedName = sanitiseCgName(name);
  const slug = slugify(cleanedName);
  const cgIdPreview = agentAddress && slug
    ? `${agentAddress}/${slug}`
    : slug ? `<agent-address>/${slug}` : '';
  const nameValidationError = name ? validateCgName(name) : null;
  const onNameChange = (raw: string) => {
    setName(raw);
  };

  const handleCreate = async () => {
    const trimmedName = cleanedName;
    if (!trimmedName || nameValidationError) return;

    setCreating(true);
    setError(null);
    setRegistrationWarning(null);
    // UI label honesty: when the operator left the "Register on chain now"
    // checkbox off (the local-first default), the create call sends
    // `register: false` and the daemon performs zero on-chain work — see
    // packages/cli/src/daemon/routes/context-graph.ts "Registration is
    // opt-in". Saying "Registering context graph on the network…" in that
    // path is misleading and was reported by operators as "why is it
    // trying to register on chain when I didn't ask for that?" Branch the
    // copy on the actual request shape instead. Same pattern as commit
    // 6b5012fd ("UI label honesty + devnet-test.sh response shape").
    setProgress(registerOnChain
      ? 'Registering context graph on the network…'
      : 'Creating context graph locally…');

    const finalSlug = slugify(trimmedName);
    if (!agentAddress) {
      setError('Agent identity is still loading. Please wait a moment and try again.');
      setCreating(false);
      return;
    }
    const cgId = `${agentAddress}/${finalSlug}`;

    try {
      const slowTimer = setTimeout(
        () => setProgress(registerOnChain
          ? 'On-chain registration in progress — this can take up to 30s…'
          : 'Setting up local context graph…'),
        5000,
      );

      // OT-RFC-38 LU-6: project creation is LOCAL-ONLY (no chain
      // interaction, no gas). On-chain registration is deferred to
      // the first VM publish, which is what the user actually opts
      // into when they choose to durabilify. SWM works immediately
      // — cores opaquely buffer curated ciphertext via host-mode
      // for the pre-registration TTL until either the CG is
      // explicitly registered or the user publishes for the first
      // time. We therefore no longer poll for an "on-chain
      // registration in progress" timer here or treat
      // `registered: false` as an error.
      //
      // SPEC_CG_MEMORY_MODEL dials:
      //   Sharing      → accessPolicy   (0 = open, 1 = invite-only)
      //   Contribution → publishPolicy  (0 = curators-only, 1 = open)
      // Defaults are safe (invite-only + curators-only); the radios
      // let the curator dial either side open explicitly.
      const accessPolicy = access === 'curated' ? 1 : 0;
      const publishPolicyWire = publishPolicy === 'curator-only' ? 0 : 1;
      // Codex PR #608 R1/R2 #5/#6/#8/#9: registration is opt-in. The
      // modal stays local-first; the user can opt into on-chain
      // registration via the "Register on chain now" checkbox (default
      // off). Registering later is a single click from the project's
      // Settings tab. Forces the publish-to-VM flow to require registration
      // explicitly, instead of pretending CG-create == on-chain CG.
      const opts: Parameters<typeof createContextGraph>[3] = access === 'curated'
        ? { accessPolicy, publishPolicy: publishPolicyWire, allowedAgents: agentAddress ? [agentAddress] : [], register: registerOnChain }
        : { accessPolicy, publishPolicy: publishPolicyWire, register: registerOnChain };

      const result = await createContextGraph(cgId, trimmedName, description.trim() || undefined, opts);
      clearTimeout(slowTimer);

      // Codex PR #608 R1/R2 #6/#9: partial-success path. If the user
      // opted into registration but it failed, surface a warning AND
      // proceed (fetchContextGraphs + setActiveProject below). Previously
      // we threw, which left the just-created CG invisible until manual
      // refresh and stranded the user with no obvious path forward.
      // The "retry from Settings" affordance below now picks up the
      // partial-success state via the refreshed list.
      if (registerOnChain && result.registered === false) {
        const registrationWarningMessage =
          `On-chain registration failed: ${result.registerError ?? 'unknown error'}. ` +
          `Project is created locally and usable for everything except Verifiable Memory publishing. ` +
          `Retry registration from the project's Settings when ready.`;
        console.warn('[CreateProjectModal]', registrationWarningMessage);
        setRegistrationWarning(registrationWarningMessage);
      }

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
          setProgress(`Context graph created, but ontology install failed: ${ontoErr?.message ?? ontoErr}`);
        }
      }

      // Phase 8: publish the project manifest so any joiner can
      // bootstrap their own Cursor wiring from the graph alone. Same
      // fail-open posture as ontology install — a missing manifest
      // doesn't invalidate the CG; the curator can re-publish later.
      let manifestPublished = true;
      try {
        setProgress('Publishing context graph manifest…');
        await publishProjectManifest(result.created, {});
      } catch (manifestErr: any) {
        manifestPublished = false;
        console.warn('[CreateProjectModal] manifest publish failed:', manifestErr);
        setProgress(`Context graph created, but manifest publish failed: ${manifestErr?.message ?? manifestErr}`);
      }

      setProgress('Refreshing context graph list…');
      const { contextGraphs: freshList } = await fetchContextGraphs();
      setContextGraphs(freshList ?? []);

      setActiveProject(result.created);
      openTab({ id: `project:${result.created}`, label: trimmedName, closable: true });
      if (stage < 2) setStage(2);

      // Phase 8: transition into the wire-workspace step ONLY if the
      // manifest publish succeeded. `WireWorkspacePanel`'s preview/
      // install flow depends on `fetchManifest()` returning the
      // just-published manifest out of the graph — if publish failed
      // (e.g. standalone/npm install without a template bundle), the
      // panel can only ever error out on the very next step. Close
      // the modal with the warning already visible in `progress`
      // instead, so the curator can see that project creation itself
      // succeeded and they can re-publish the manifest later. Codex
      // tier-4j finding on CreateProjectModal.tsx:147.
      if (manifestPublished) {
        setWiredProjectName(trimmedName);
        setWiredCgId(result.created);
        setProgress('');
      } else {
        // Leave `progress` showing the manifest-publish warning and
        // defer closing by a short beat so the user sees the message.
        setTimeout(() => {
          setName('');
          setDescription('');
          setProgress('');
          onClose();
        }, 2500);
      }
    } catch (err: any) {
      const msg = err?.message || 'Failed to create context graph';
      if (msg.includes('already exists') || msg.includes('409')) {
        setError('A context graph with this ID already exists. Try a different name.');
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

  // Phase 8: after CG creation succeeds we drop the create form and
  // render the WireWorkspacePanel inline. The modal stays open and
  // remains "the create flow" until the operator clicks Done or Skip.
  function handleWireDone() {
    setWiredCgId(null);
    setWiredProjectName('');
    setRegistrationWarning(null);
    setName('');
    setDescription('');
    onClose();
  }

  if (wiredCgId) {
    return (
      <div
        className="v10-modal-overlay"
        onClick={wiredDismiss.onBackdropClick}
        role="presentation"
      >
        <div
          className="v10-modal-box"
          ref={wiredDismiss.dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="dkg-wire-modal-title"
        >
          <button
            type="button"
            className="v10-modal-close"
            onClick={handleWireDone}
            aria-label="Close wire workspace dialog"
            title="Close (Esc)"
            style={{ position: 'absolute', top: 12, right: 12, background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 4 }}
          >
            ×
          </button>
          <div className="v10-modal-header">
            <div id="dkg-wire-modal-title" className="v10-modal-title">Wire workspace for {wiredProjectName}</div>
            <div className="v10-modal-subtitle">
              Context graph created. Now wire a local workspace so you can plan it from your own Cursor.
            </div>
          </div>
          <div className="v10-modal-body">
            {registrationWarning && (
              <div className="v10-modal-warning">
                {registrationWarning}
              </div>
            )}
            <WireWorkspacePanel
              contextGraphId={wiredCgId}
              projectName={wiredProjectName}
              variant="create"
              onDone={handleWireDone}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="v10-modal-overlay"
      onClick={wireDismiss.onBackdropClick}
      role="presentation"
    >
      <div
        className="v10-modal-box"
        ref={wireDismiss.dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dkg-create-cg-title"
        aria-describedby="dkg-create-cg-subtitle"
      >
        <button
          type="button"
          className="v10-modal-close"
          onClick={onClose}
          aria-label="Close create context graph dialog"
          title="Close (Esc)"
          style={{ position: 'absolute', top: 12, right: 12, background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 4, zIndex: 1 }}
        >
          ×
        </button>
        <div className="v10-modal-header">
          <div id="dkg-create-cg-title" className="v10-modal-title">Create New Context Graph</div>
          <div id="dkg-create-cg-subtitle" className="v10-modal-subtitle">
            A context graph gives your agent structured memory — a place to draft, share, and publish knowledge.
          </div>
        </div>

        <div className="v10-modal-body">
          {error && (
            <div className="v10-modal-error">
              {error}
            </div>
          )}

          {registrationWarning && (
            <div className="v10-modal-warning">
              {registrationWarning}
            </div>
          )}

          {isFirstProject && (
            <div className="v10-modal-tip">
              <div className="v10-modal-tip-title">First context graph tip</div>
              This is your agent's first memory space. Consider importing any existing knowledge
              your agent has — notes, documents, conversation logs — so it can build on what it already knows.
            </div>
          )}

          <div className="v10-form-group">
            <label className="v10-form-label" htmlFor="dkg-cg-name">Context Graph Name</label>
            <input
              id="dkg-cg-name"
              name="dkg-cg-name"
              className="v10-form-input"
              type="text"
              placeholder="e.g. Pharma Drug Interactions"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              autoFocus
              maxLength={CG_NAME_MAX_LENGTH}
              aria-invalid={nameValidationError ? 'true' : 'false'}
              aria-describedby="dkg-cg-name-help"
              autoComplete="off"
              spellCheck={true}
            />
            <div
              id="dkg-cg-name-help"
              style={{ marginTop: 4, fontSize: 11, color: nameValidationError ? 'var(--red, #f87171)' : 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}
            >
              {nameValidationError
                ? nameValidationError
                : cgIdPreview
                  ? `ID: did:dkg:context-graph:${cgIdPreview}`
                  : `${name.length}/${CG_NAME_MAX_LENGTH} characters`}
            </div>
          </div>

          <div className="v10-form-group">
            <label className="v10-form-label" htmlFor="dkg-cg-description">Description</label>
            <textarea
              id="dkg-cg-description"
              name="dkg-cg-description"
              className="v10-form-textarea"
              placeholder="What should your agent remember? Describe the domain, goals, or context..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-label="Context graph description"
            />
          </div>

          <div className="v10-form-divider" />

          <div className="v10-form-group">
            <label className="v10-form-label">Sharing</label>
            <div className="v10-form-radio-group">
              <label className="v10-form-radio">
                <input type="radio" checked={access === 'curated'} onChange={() => setAccess('curated')} />
                Invite-only — only invited agents can read and subscribe
              </label>
              <label className="v10-form-radio">
                <input type="radio" checked={access === 'public'} onChange={() => setAccess('public')} />
                Open — publicly discoverable; anyone can subscribe
              </label>
            </div>
          </div>

          <div className="v10-form-group">
            <label className="v10-form-label">Contribution</label>
            <div className="v10-form-radio-group">
              <label className="v10-form-radio">
                <input type="radio" checked={publishPolicy === 'curator-only'} onChange={() => setPublishPolicy('curator-only')} />
                Curators-only — only the curator may publish to Verifiable Memory
              </label>
              <label className="v10-form-radio">
                <input type="radio" checked={publishPolicy === 'open'} onChange={() => setPublishPolicy('open')} />
                Open — any wallet may publish to Verifiable Memory (not just members)
              </label>
            </div>
            {access === 'curated' && publishPolicy === 'open' && (
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-tertiary)' }}>
                Note: an invite-only sharing graph with open contribution still lets <em>any</em> wallet
                publish to Verifiable Memory — the on-chain publish check is not gated by the allowlist.
                See SPEC_CG_MEMORY_MODEL §2.5.
              </div>
            )}
          </div>

          <div className="v10-form-group">
            <label className="v10-form-label">On-chain registration</label>
            <label className="v10-form-radio" style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <input
                type="checkbox"
                checked={registerOnChain}
                onChange={(e) => setRegisterOnChain(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                Register on chain now (required for Verifiable Memory publishing)
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                  Off by default — the project is created locally and can be registered later
                  from its Settings tab when your wallet is funded and a working RPC is configured.
                </div>
              </span>
            </label>
          </div>

          <div className="v10-form-group">
            <label className="v10-form-label">Ontology</label>
            <div className="v10-form-radio-group">
              <label className="v10-form-radio">
                <input type="radio" checked={ontology === 'community'} onChange={() => setOntology('community')} />
                Choose a starter — install one of the bundled context-graph-type ontologies
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
                  release will have the agent draft a context-graph-specific ontology by extending the closest
                  starter from the context graph description.
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
          {identityError && (
            <button className="v10-modal-btn" onClick={loadAgentIdentity} disabled={identityLoading}>
              {identityLoading ? 'Retrying…' : 'Retry Loading Agent'}
            </button>
          )}
          <button
            className="v10-modal-btn primary"
            onClick={handleCreate}
            disabled={!name.trim() || !!validateCgName(name) || creating || !agentAddress || identityLoading}
          >
            {creating
              ? progress || 'Creating…'
              : !agentAddress
                // Only call the agent "unavailable" once the identity load
                // has actually failed. Before that (initial open + in-flight
                // fetch) the address is simply not resolved yet, so show a
                // loading state instead of flashing an error label. (F4)
                ? (identityError ? 'Agent unavailable' : 'Loading agent…')
                : 'Create Context Graph'}
          </button>
        </div>
      </div>
    </div>
  );
}
