/**
 * Activity Manager — tracks agent sessions, file claims, decisions, and annotations.
 *
 * All state is held in-memory (Maps). RDF quads are generated on mutation
 * and returned to the caller for workspace writes.
 */

import { randomUUID } from 'node:crypto';
import {
  transformSession,
  transformClaim,
  transformDecision,
  transformAnnotation,
  type AgentSessionData,
  type CodeClaimData,
  type DecisionData,
  type AnnotationData,
} from '../rdf/code-transformer.js';
import type { Quad } from '../rdf/uri.js';

// --- Public interfaces ---

export interface AgentSession {
  sessionId: string;
  agentName: string;
  peerId: string;
  goal?: string;
  relatedPr?: number;
  relatedIssue?: number;
  startedAt: number;
  lastHeartbeat: number;
  status: 'active' | 'ended' | 'abandoned';
  modifiedFiles: string[];
  summary?: string;
  remote?: boolean;
  repoKey?: string;
}

export interface CodeClaim {
  claimId: string;
  filePath: string;
  repoKey?: string;
  peerId: string;
  agentName: string;
  sessionId: string;
  claimedAt: number;
  remote?: boolean;
}

export interface Decision {
  decisionId: string;
  summary: string;
  rationale: string;
  alternatives?: string[];
  affectedFiles: string[];
  peerId: string;
  agentName: string;
  sessionId?: string;
  createdAt: number;
  remote?: boolean;
  repoKey?: string;
}

export interface Annotation {
  annotationId: string;
  targetUri: string;
  kind: 'finding' | 'suggestion' | 'warning' | 'note';
  content: string;
  peerId: string;
  agentName: string;
  sessionId?: string;
  createdAt: number;
  remote?: boolean;
}

export interface ClaimResult {
  claimed: CodeClaim[];
  conflicts: Array<{
    file: string;
    existingClaim: CodeClaim;
  }>;
}

export interface ActivityEntry {
  type: string;
  agent: string;
  timestamp: number;
  detail: string;
  entityId?: string;
}

/** Heartbeat timeout: 5 minutes. */
const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;

export class ActivityManager {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly claims = new Map<string, CodeClaim>();
  /** "repoKey:filePath" → claimId for fast conflict lookup */
  private readonly fileClaimIndex = new Map<string, string>();
  private readonly decisions: Decision[] = [];
  private readonly annotations: Annotation[] = [];
  private readonly log: (msg: string) => void;

  constructor(log?: (msg: string) => void) {
    this.log = log ?? ((msg: string) => console.log(`[activity] ${msg}`));
  }

  /** Composite key for fileClaimIndex to avoid cross-repo conflicts. */
  private claimKey(repoKey: string | undefined, filePath: string): string {
    return repoKey ? `${repoKey}:${filePath}` : filePath;
  }

  // --- Sessions ---

  startSession(
    agentName: string,
    peerId: string,
    opts?: { goal?: string; relatedPr?: number; relatedIssue?: number },
  ): AgentSession {
    const sessionId = `sess-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const session: AgentSession = {
      sessionId,
      agentName,
      peerId,
      goal: opts?.goal,
      relatedPr: opts?.relatedPr,
      relatedIssue: opts?.relatedIssue,
      startedAt: now,
      lastHeartbeat: now,
      status: 'active',
      modifiedFiles: [],
    };
    this.sessions.set(sessionId, session);
    this.log(`Session started: ${sessionId} by ${agentName}`);
    return session;
  }

  heartbeatSession(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (session.status !== 'active') throw new Error(`Session ${sessionId} is ${session.status}`);
    session.lastHeartbeat = Date.now();
    return session;
  }

  addModifiedFiles(
    sessionId: string,
    files: string[],
    repoKey?: string,
  ): { session: AgentSession; warnings: Array<{ file: string; claimedBy: string; since: string }> } {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const rk = repoKey ?? session.repoKey;

    const warnings: Array<{ file: string; claimedBy: string; since: string }> = [];
    for (const file of files) {
      if (!session.modifiedFiles.includes(file)) {
        session.modifiedFiles.push(file);
      }
      // Check for claim conflicts
      const existingClaimId = this.fileClaimIndex.get(this.claimKey(rk, file));
      if (existingClaimId) {
        const existing = this.claims.get(existingClaimId);
        if (existing && existing.sessionId !== sessionId) {
          warnings.push({
            file,
            claimedBy: existing.agentName,
            since: new Date(existing.claimedAt).toISOString(),
          });
        }
      }
    }
    return { session, warnings };
  }

  endSession(sessionId: string, summary?: string): { session: AgentSession; releasedClaims: string[] } {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.status = 'ended';
    session.summary = summary;

    // Release all claims for this session
    const released = this.releaseClaimsForSession(sessionId);

    this.log(`Session ended: ${sessionId} (${session.modifiedFiles.length} files, ${released.length} claims released)`);
    return { session, releasedClaims: released };
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  // --- Claims ---

  claimFiles(
    filePaths: string[],
    sessionId: string,
    agentName: string,
    peerId: string,
    repoKey?: string,
  ): ClaimResult {
    const claimed: CodeClaim[] = [];
    const conflicts: Array<{ file: string; existingClaim: CodeClaim }> = [];
    const now = Date.now();

    for (const filePath of filePaths) {
      const key = this.claimKey(repoKey, filePath);
      const existingClaimId = this.fileClaimIndex.get(key);
      if (existingClaimId) {
        const existing = this.claims.get(existingClaimId);
        if (existing && existing.sessionId !== sessionId) {
          conflicts.push({ file: filePath, existingClaim: existing });
          continue;
        }
      }

      const claimId = `clm-${randomUUID().slice(0, 8)}`;
      const claim: CodeClaim = {
        claimId,
        filePath,
        repoKey,
        peerId,
        agentName,
        sessionId,
        claimedAt: now,
      };
      this.claims.set(claimId, claim);
      this.fileClaimIndex.set(key, claimId);
      claimed.push(claim);
    }

    return { claimed, conflicts };
  }

  releaseClaim(claimId: string): CodeClaim | undefined {
    const claim = this.claims.get(claimId);
    if (!claim) return undefined;
    this.claims.delete(claimId);
    const key = this.claimKey(claim.repoKey, claim.filePath);
    if (this.fileClaimIndex.get(key) === claimId) {
      this.fileClaimIndex.delete(key);
    }
    return claim;
  }

  getActiveClaims(repoKey?: string): CodeClaim[] {
    // repoKey filter is for future multi-repo support; currently returns all
    void repoKey;
    return [...this.claims.values()];
  }

  // --- Decisions ---

  recordDecision(input: {
    summary: string;
    rationale: string;
    alternatives?: string[];
    affectedFiles: string[];
    peerId: string;
    agentName: string;
    sessionId?: string;
  }): Decision {
    const decisionId = `dec-${randomUUID().slice(0, 8)}`;
    const decision: Decision = {
      decisionId,
      ...input,
      createdAt: Date.now(),
    };
    this.decisions.push(decision);
    this.log(`Decision recorded: ${decisionId} by ${input.agentName}`);
    return decision;
  }

  getDecisions(_repoKey?: string): Decision[] {
    return [...this.decisions];
  }

  // --- Annotations ---

  addAnnotation(input: {
    targetUri: string;
    kind: 'finding' | 'suggestion' | 'warning' | 'note';
    content: string;
    peerId: string;
    agentName: string;
    sessionId?: string;
  }): Annotation {
    const annotationId = `ann-${randomUUID().slice(0, 8)}`;
    const annotation: Annotation = {
      annotationId,
      ...input,
      createdAt: Date.now(),
    };
    this.annotations.push(annotation);
    return annotation;
  }

  // --- Remote mirroring (store remote activity without generating RDF) ---

  mirrorRemoteSession(data: {
    sessionId: string;
    agentName: string;
    peerId: string;
    goal?: string;
    startedAt: number;
    repoKey?: string;
  }): void {
    if (this.sessions.has(data.sessionId)) return; // already mirrored
    const session: AgentSession = {
      sessionId: data.sessionId,
      agentName: data.agentName,
      peerId: data.peerId,
      goal: data.goal,
      startedAt: data.startedAt,
      lastHeartbeat: data.startedAt,
      status: 'active',
      modifiedFiles: [],
      remote: true,
      repoKey: data.repoKey,
    };
    this.sessions.set(data.sessionId, session);
    this.log(`Mirrored remote session: ${data.sessionId} by ${data.agentName}`);
  }

  mirrorRemoteSessionEnd(sessionId: string, summary?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.status = 'ended';
    session.summary = summary;
    session.lastHeartbeat = Date.now();
  }

  mirrorRemoteHeartbeat(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.lastHeartbeat = Date.now();
  }

  mirrorRemoteClaim(
    claimId: string,
    filePath: string,
    peerId: string,
    agentName: string,
    sessionId: string,
    repoKey?: string,
  ): void {
    if (this.claims.has(claimId)) return; // already mirrored
    const claim: CodeClaim = {
      claimId,
      filePath,
      repoKey,
      peerId,
      agentName,
      sessionId,
      claimedAt: Date.now(),
      remote: true,
    };
    this.claims.set(claimId, claim);
    this.fileClaimIndex.set(this.claimKey(repoKey, filePath), claimId);
  }

  mirrorRemoteClaimRelease(claimId: string): void {
    const claim = this.claims.get(claimId);
    if (!claim) return;
    this.claims.delete(claimId);
    const key = this.claimKey(claim.repoKey, claim.filePath);
    if (this.fileClaimIndex.get(key) === claimId) {
      this.fileClaimIndex.delete(key);
    }
  }

  mirrorRemoteDecision(data: {
    decisionId: string;
    summary: string;
    peerId: string;
    agentName: string;
    createdAt: number;
    repoKey?: string;
  }): void {
    // Avoid duplicates
    if (this.decisions.some(d => d.decisionId === data.decisionId)) return;
    this.decisions.push({
      decisionId: data.decisionId,
      summary: data.summary,
      rationale: '',
      affectedFiles: [],
      peerId: data.peerId,
      agentName: data.agentName,
      createdAt: data.createdAt,
      remote: true,
      repoKey: data.repoKey,
    });
  }

  mirrorRemoteAnnotation(data: {
    annotationId: string;
    targetUri: string;
    kind: 'finding' | 'suggestion' | 'warning' | 'note';
    content: string;
    peerId: string;
    agentName: string;
    createdAt: number;
  }): void {
    if (this.annotations.some(a => a.annotationId === data.annotationId)) return;
    this.annotations.push({
      ...data,
      remote: true,
    });
  }

  // --- Queries ---

  getSessions(opts?: { status?: string }): AgentSession[] {
    let result = [...this.sessions.values()];
    if (opts?.status) {
      result = result.filter(s => s.status === opts.status);
    }
    return result;
  }

  getActivity(limit = 50, repoKey?: string): ActivityEntry[] {
    const entries: ActivityEntry[] = [];

    for (const s of this.sessions.values()) {
      if (repoKey && s.repoKey && s.repoKey !== repoKey) continue;
      entries.push({
        type: 'session:started',
        agent: s.agentName,
        timestamp: s.startedAt,
        detail: s.goal ? `Started session: ${s.goal}` : `Started session`,
        entityId: s.sessionId,
      });
      if (s.status === 'ended' || s.status === 'abandoned') {
        entries.push({
          type: `session:${s.status}`,
          agent: s.agentName,
          timestamp: s.lastHeartbeat,
          detail: s.summary ? `Completed session: ${s.summary}` : `Session ${s.status}`,
          entityId: s.sessionId,
        });
      }
    }

    for (const c of this.claims.values()) {
      // Claims are linked to sessions; filter via session's repoKey
      if (repoKey) {
        const session = this.sessions.get(c.sessionId);
        if (session?.repoKey && session.repoKey !== repoKey) continue;
      }
      entries.push({
        type: 'claim:created',
        agent: c.agentName,
        timestamp: c.claimedAt,
        detail: `Claimed ${c.filePath}`,
        entityId: c.claimId,
      });
    }

    for (const d of this.decisions) {
      if (repoKey && d.repoKey && d.repoKey !== repoKey) continue;
      entries.push({
        type: 'decision:recorded',
        agent: d.agentName,
        timestamp: d.createdAt,
        detail: `Decision: ${d.summary}`,
        entityId: d.decisionId,
      });
    }

    for (const a of this.annotations) {
      entries.push({
        type: 'annotation:added',
        agent: a.agentName,
        timestamp: a.createdAt,
        detail: `${a.kind}: ${a.content}`,
        entityId: a.annotationId,
      });
    }

    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries.slice(0, limit);
  }

  // --- RDF Generation ---

  generateSessionQuads(session: AgentSession, owner: string, repo: string, graph: string): Quad[] {
    const data: AgentSessionData = {
      sessionId: session.sessionId,
      agentName: session.agentName,
      peerId: session.peerId,
      goal: session.goal,
      relatedPr: session.relatedPr,
      relatedIssue: session.relatedIssue,
      startedAt: session.startedAt,
      endedAt: session.status !== 'active' ? session.lastHeartbeat : undefined,
      status: session.status,
      modifiedFiles: session.modifiedFiles,
      summary: session.summary,
    };
    return transformSession(data, owner, repo, graph);
  }

  generateClaimQuads(claim: CodeClaim, owner: string, repo: string, graph: string): Quad[] {
    const data: CodeClaimData = {
      claimId: claim.claimId,
      filePath: claim.filePath,
      peerId: claim.peerId,
      agentName: claim.agentName,
      sessionId: claim.sessionId,
      claimedAt: claim.claimedAt,
    };
    return transformClaim(data, owner, repo, graph);
  }

  generateDecisionQuads(decision: Decision, owner: string, repo: string, graph: string): Quad[] {
    const data: DecisionData = { ...decision };
    return transformDecision(data, owner, repo, graph);
  }

  generateAnnotationQuads(annotation: Annotation, owner: string, repo: string, graph: string): Quad[] {
    const data: AnnotationData = { ...annotation };
    return transformAnnotation(data, owner, repo, graph);
  }

  // --- Cleanup ---

  /**
   * Abandon sessions that haven't sent a heartbeat within the timeout.
   * Returns the list of abandoned session IDs.
   */
  cleanupAbandonedSessions(): string[] {
    const now = Date.now();
    const abandoned: string[] = [];

    for (const session of this.sessions.values()) {
      if (session.status === 'active' && now - session.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        session.status = 'abandoned';
        this.releaseClaimsForSession(session.sessionId);
        abandoned.push(session.sessionId);
        this.log(`Session abandoned: ${session.sessionId} (no heartbeat for >5 min)`);
      }
    }

    return abandoned;
  }

  // --- Internal helpers ---

  private releaseClaimsForSession(sessionId: string): string[] {
    const released: string[] = [];
    for (const [claimId, claim] of this.claims) {
      if (claim.sessionId === sessionId) {
        this.claims.delete(claimId);
        const key = this.claimKey(claim.repoKey, claim.filePath);
        if (this.fileClaimIndex.get(key) === claimId) {
          this.fileClaimIndex.delete(key);
        }
        released.push(claimId);
      }
    }
    return released;
  }
}
