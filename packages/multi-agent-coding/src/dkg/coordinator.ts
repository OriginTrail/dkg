/**
 * GitHub Collaboration Coordinator
 *
 * Bridges the GitHub Collaboration app with the DKG network:
 * - Paranet management (per-repo paranets)
 * - Workspace operations for ephemeral data
 * - GossipSub for real-time coordination
 * - Context graphs for multi-reviewer consensus
 * - Sync engine orchestration
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SyncEngine, type RepoSyncConfig, type SyncScope, type SyncJob, type WebhookResult } from './sync-engine.js';
import { APP_ID, encodeMessage, decodeMessage, type AppMessage, type MessageType } from './protocol.js';
import { paranetId as makeParanetId, generateParanetSuffix, type Quad } from '../rdf/uri.js';
import {
  ActivityManager,
  type AgentSession,
  type CodeClaim,
  type Decision,
  type Annotation,
  type ClaimResult,
  type ActivityEntry,
} from './activity-manager.js';

/** Path to persistent config file. */
function configFilePath(): string {
  const dkgHome = process.env.DKG_HOME ?? join(homedir(), '.dkg');
  const appDir = join(dkgHome, 'apps', 'github-collab');
  if (!existsSync(appDir)) mkdirSync(appDir, { recursive: true });
  return join(appDir, 'config.json');
}

/** Minimal DKGAgent interface — only the methods the coordinator needs. */
interface DKGAgent {
  peerId: string;
  identityId: bigint;
  gossip: {
    subscribe(topic: string): void;
    publish(topic: string, data: Uint8Array): Promise<void>;
    onMessage(topic: string, handler: (topic: string, data: Uint8Array, from: string) => void): void;
    offMessage(topic: string, handler: (topic: string, data: Uint8Array, from: string) => void): void;
  };
  createParanet(opts: {
    id: string;
    name: string;
    description?: string;
    private?: boolean;
  }): Promise<void>;
  writeToWorkspace(paranetId: string, quads: Quad[], opts?: any): Promise<{ workspaceOperationId: string }>;
  enshrineFromWorkspace(
    paranetId: string,
    selection: 'all' | { rootEntities: string[] },
    options?: any,
  ): Promise<any>;
  query(sparql: string, options?: any): Promise<any>;
}

export interface RepoConfig {
  owner: string;
  repo: string;
  githubToken?: string;
  webhookSecret?: string;
  pollIntervalMs: number;
  syncScope: SyncScope[];
  paranetId: string;
  suffix?: string;
  lastSyncAt?: string;
  privacyLevel: 'local' | 'shared';
}

export interface ReviewSession {
  sessionId: string;
  repo: string;
  prNumber: number;
  requiredApprovals: number;
  reviewers: string[];
  reviews: Array<{
    peerId: string;
    decision: string;
    timestamp: number;
  }>;
  status: 'pending' | 'approved' | 'changes_requested';
  contextGraphId?: string;
  ual?: string;
  enshrined: boolean;
}

export interface Invitation {
  invitationId: string;
  repoKey: string;
  paranetId: string;
  fromPeerId: string;
  fromNodeName?: string;
  toPeerId: string;
  status: 'pending' | 'accepted' | 'declined' | 'revoked';
  direction: 'sent' | 'received';
  createdAt: number;
}

export interface PeerInfo {
  peerId: string;
  name?: string;
  connected: boolean;
  lastSeen: number;
  repos: string[];
}

export class GitHubCollabCoordinator {
  readonly myPeerId: string;
  private readonly agent: DKGAgent;
  private readonly nodeName: string;
  private readonly repos = new Map<string, RepoConfig>();
  private readonly syncEngine: SyncEngine;
  private readonly reviewSessions = new Map<string, ReviewSession>();
  private readonly sentInvitations = new Map<string, Invitation>();
  private readonly receivedInvitations = new Map<string, Invitation>();
  private readonly peers = new Map<string, PeerInfo>();
  private readonly subscribedTopics = new Set<string>();
  private readonly gossipHandler: (topic: string, data: Uint8Array, from: string) => void;
  private readonly log: (msg: string) => void;
  private readonly configPath: string | null;
  private pingTimer?: ReturnType<typeof setInterval>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  readonly activity: ActivityManager;

  constructor(agent: DKGAgent, config?: { name?: string; configPath?: string | null }, log?: (msg: string) => void) {
    this.agent = agent;
    this.myPeerId = agent.peerId;
    this.nodeName = config?.name ?? agent.peerId.slice(0, 8);
    this.log = log ?? ((msg: string) => console.log(`[github-collab] ${msg}`));
    // configPath: null = disable persistence (for tests), undefined = use default
    this.configPath = config?.configPath === null ? null : (config?.configPath ?? configFilePath());

    this.syncEngine = new SyncEngine(
      (paranetId, quads) => this.writeToWorkspace(paranetId, quads),
      (repoKey, scope, quadsWritten) => this.onSyncComplete(repoKey, scope, quadsWritten),
    );

    this.activity = new ActivityManager(this.log);

    this.gossipHandler = (topic: string, data: Uint8Array, from: string) => {
      this.handleGossipMessage(topic, data, from);
    };

    // Ping timer for presence tracking
    this.pingTimer = setInterval(() => this.broadcastPing(), 60_000);

    // Cleanup timer for abandoned sessions (every 2 min)
    this.cleanupTimer = setInterval(() => this.activity.cleanupAbandonedSessions(), 120_000);

    // Restore saved repo configs from disk
    this.restoreFromDisk();
  }

  /** Save repo configs to disk so they survive daemon restarts. */
  private saveToDisk(): void {
    if (!this.configPath) return; // persistence disabled (tests)
    try {
      const dir = this.configPath.replace(/[/\\][^/\\]+$/, '');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data = {
        repos: [...this.repos.values()],
      };
      writeFileSync(this.configPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err: any) {
      this.log(`Failed to save config: ${err.message}`);
    }
  }

  /** Restore repo configs from disk on startup. */
  private restoreFromDisk(): void {
    if (!this.configPath) return; // persistence disabled (tests)
    try {
      if (!existsSync(this.configPath)) return;
      const data = JSON.parse(readFileSync(this.configPath!, 'utf-8'));
      if (!data.repos || !Array.isArray(data.repos)) return;

      for (const saved of data.repos) {
        const repoKey = `${saved.owner}/${saved.repo}`;
        this.repos.set(repoKey, saved);
        // Re-register with sync engine
        this.syncEngine.addRepo({ ...saved });
        // Re-subscribe to GossipSub for shared repos
        if (saved.privacyLevel === 'shared') {
          this.subscribeToParanet(saved.paranetId);
        }
        this.log(`Restored repo ${repoKey} (${saved.privacyLevel})`);
      }
    } catch (err: any) {
      this.log(`Failed to restore config: ${err.message}`);
    }
  }

  // --- Repo Configuration ---

  async addRepo(config: {
    owner: string;
    repo: string;
    githubToken?: string;
    webhookSecret?: string;
    pollIntervalMs?: number;
    syncScope?: SyncScope[];
    paranetId?: string;
    suffix?: string;
    privacyLevel?: 'local' | 'shared';
  }): Promise<{ paranetId: string; repoKey: string }> {
    const repoKey = `${config.owner}/${config.repo}`;
    const existing = this.repos.get(repoKey);

    // If repo already exists, merge updates (e.g., adding token to existing repo)
    if (existing) {
      if (config.githubToken) existing.githubToken = config.githubToken;
      if (config.webhookSecret) existing.webhookSecret = config.webhookSecret;
      if (config.pollIntervalMs) existing.pollIntervalMs = config.pollIntervalMs;
      if (config.syncScope) existing.syncScope = config.syncScope;
      // Re-register with sync engine to pick up new token
      this.syncEngine.addRepo({ ...existing });
      this.log(`Updated repo ${repoKey}${config.githubToken ? ' (token added)' : ''}`);
      this.saveToDisk();
      return { paranetId: existing.paranetId, repoKey };
    }

    const privacy = config.privacyLevel ?? 'local';
    // For shared mode, generate a random suffix to make the paranet ID unique
    const suffix = config.suffix ?? (privacy === 'shared' && !config.paranetId ? generateParanetSuffix() : undefined);
    const pId = config.paranetId ?? makeParanetId(config.owner, config.repo, suffix);

    const repoConfig: RepoConfig = {
      owner: config.owner,
      repo: config.repo,
      githubToken: config.githubToken,
      webhookSecret: config.webhookSecret,
      pollIntervalMs: config.pollIntervalMs ?? 300_000,
      syncScope: config.syncScope ?? ['pull_requests', 'issues', 'reviews', 'commits', 'code_structure'],
      paranetId: pId,
      suffix,
      privacyLevel: privacy,
    };

    this.repos.set(repoKey, repoConfig);

    // Create the paranet in the local triple store
    // For local repos: private paranet (no chain, no gossip)
    // For shared repos: normal paranet
    try {
      await this.agent.createParanet({
        id: pId,
        name: `GitHub: ${config.owner}/${config.repo}`,
        description: `Knowledge graph for github.com/${config.owner}/${config.repo}`,
        private: privacy === 'local',
      });
    } catch (err: any) {
      // Paranet might already exist from a previous session
      if (!err.message?.includes('already exists')) {
        throw err;
      }
    }

    // Set up sync engine (works with or without token — public repos don't need one)
    this.syncEngine.addRepo({
      ...repoConfig,
      githubToken: config.githubToken,
    });

    if (privacy === 'shared') {
      // Subscribe to paranet gossip topics
      this.subscribeToParanet(pId);

      // Announce join
      await this.broadcastMessage(pId, {
        app: APP_ID,
        type: 'node:joined',
        peerId: this.myPeerId,
        timestamp: Date.now(),
        repo: repoKey,
        nodeName: this.nodeName,
      });

      this.log(`Added repo ${repoKey} → paranet ${pId} (shared mode)`);
    } else {
      this.log(`Added repo ${repoKey} in local-only mode (no P2P sharing)`);
    }

    this.saveToDisk();
    return { paranetId: pId, repoKey };
  }

  removeRepo(owner: string, repo: string): void {
    const repoKey = `${owner}/${repo}`;
    const config = this.repos.get(repoKey);
    if (!config) return;

    // Broadcast leave before cleanup
    this.broadcastMessage(config.paranetId, {
      app: APP_ID,
      type: 'node:left',
      peerId: this.myPeerId,
      timestamp: Date.now(),
      repo: repoKey,
    }).catch(() => {});

    // Unsubscribe from gossip
    const topic = `dkg/paranet/${config.paranetId}/app`;
    this.agent.gossip.offMessage(topic, this.gossipHandler);
    this.subscribedTopics.delete(topic);

    this.syncEngine.removeRepo(owner, repo);
    this.repos.delete(repoKey);
    this.log(`Removed repo ${repoKey}`);
    this.saveToDisk();
  }

  async convertToShared(owner: string, repo: string): Promise<{ paranetId: string; syncJobId?: string }> {
    const repoKey = `${owner}/${repo}`;
    const config = this.repos.get(repoKey);
    if (!config) throw new Error(`Repository ${repoKey} is not configured`);
    if (config.privacyLevel === 'shared') {
      return { paranetId: config.paranetId };
    }

    const suffix = generateParanetSuffix();
    const newParanetId = makeParanetId(owner, repo, suffix);

    // Create new non-private paranet
    await this.agent.createParanet({
      id: newParanetId,
      name: `GitHub: ${owner}/${repo}`,
      description: `Knowledge graph for github.com/${owner}/${repo}`,
      private: false,
    });

    // Subscribe to GossipSub
    this.subscribeToParanet(newParanetId);

    // Update config
    config.paranetId = newParanetId;
    config.suffix = suffix;
    config.privacyLevel = 'shared';

    // Update sync engine config
    this.syncEngine.removeRepo(owner, repo);
    this.syncEngine.addRepo({ ...config });

    // Announce join
    await this.broadcastMessage(newParanetId, {
      app: APP_ID,
      type: 'node:joined',
      peerId: this.myPeerId,
      timestamp: Date.now(),
      repo: repoKey,
      nodeName: this.nodeName,
    });

    this.log(`Converted ${repoKey} to shared mode → paranet ${newParanetId}`);
    this.saveToDisk();

    // Auto-trigger full sync to migrate data into the new shared paranet
    let syncJobId: string | undefined;
    if (config.githubToken) {
      try {
        const job = await this.syncEngine.startFullSync(owner, repo);
        syncJobId = job.jobId;
        this.log(`Migration sync started for ${repoKey}: job ${syncJobId}`);
      } catch (err: any) {
        this.log(`Migration sync failed to start for ${repoKey}: ${err.message}`);
      }
    } else {
      this.log(`No GitHub token for ${repoKey} — re-sync requires a GitHub token. Add one in Settings.`);
    }

    return { paranetId: newParanetId, syncJobId };
  }

  getRepoConfig(owner: string, repo: string): RepoConfig | undefined {
    return this.repos.get(`${owner}/${repo}`);
  }

  getConfiguredRepos(): RepoConfig[] {
    return [...this.repos.values()];
  }

  // --- Workspace Operations ---

  async writeToWorkspace(paranetId: string, quads: Quad[]): Promise<void> {
    if (quads.length === 0) return;
    const repoConfig = this.findRepoByParanetId(paranetId);
    const isLocal = repoConfig?.privacyLevel === 'local';
    await this.agent.writeToWorkspace(paranetId, quads as any[], isLocal ? { localOnly: true } : undefined);
  }

  async enshrineData(
    paranetId: string,
    selection: 'all' | { rootEntities: string[] },
    options?: { clearWorkspaceAfter?: boolean },
  ): Promise<any> {
    const repoConfig = this.findRepoByParanetId(paranetId);
    if (repoConfig?.privacyLevel === 'local') {
      this.log(`Skipping enshrinement for local-only repo (paranet ${paranetId})`);
      return { skipped: true, reason: 'local-only' };
    }
    return this.agent.enshrineFromWorkspace(paranetId, selection, options);
  }

  // --- Query ---

  async query(sparql: string, repoKey?: string, includeWorkspace = true): Promise<any> {
    const opts: any = {};
    if (repoKey) {
      const config = this.repos.get(repoKey);
      if (config) opts.paranetId = config.paranetId;
    }
    if (includeWorkspace && opts.paranetId) {
      // All synced data lives in the workspace graph — query it directly.
      // Using graphSuffix scopes to the workspace named graph, which is where
      // writeToWorkspace stores quads.  includeWorkspace would also run a
      // redundant query against the empty data graph.
      opts.graphSuffix = '_workspace';
    } else if (includeWorkspace) {
      opts.includeWorkspace = true;
    }
    return this.agent.query(sparql, opts);
  }

  // --- Sync ---

  async processWebhook(
    event: string,
    action: string | undefined,
    payload: any,
    deliveryId?: string,
    body?: Buffer,
    signature?: string,
  ): Promise<WebhookResult> {
    // Validate signature if webhook secret is configured
    const repoData = payload.repository;
    if (repoData?.owner?.login && repoData?.name) {
      const config = this.repos.get(`${repoData.owner.login}/${repoData.name}`);
      if (config?.webhookSecret && body) {
        if (!this.syncEngine.validateWebhook(body, signature, config.webhookSecret)) {
          return { ok: false, event, action, quadsWritten: 0 };
        }
      }
    }

    const result = await this.syncEngine.processWebhook(event, action, payload, deliveryId);

    // Enshrinement is user-initiated only — no auto-enshrine on PR merge/close.
    // The data stays in the workspace until the user explicitly chooses to publish.

    return result;
  }

  async startSync(
    owner: string,
    repo: string,
    scope?: SyncScope[],
    since?: string,
  ): Promise<SyncJob> {
    return this.syncEngine.startFullSync(owner, repo, scope, since);
  }

  getSyncStatus(jobId: string): SyncJob | undefined {
    return this.syncEngine.getSyncJob(jobId);
  }

  getSyncStatusForRepo(repoKey: string): SyncJob | undefined {
    return this.syncEngine.getSyncJobForRepo(repoKey);
  }

  startPolling(repoKey: string): void {
    this.syncEngine.startPolling(repoKey);
  }

  stopPolling(repoKey: string): void {
    this.syncEngine.stopPolling(repoKey);
  }

  // --- Review Sessions ---

  async createReviewSession(
    owner: string,
    repo: string,
    prNumber: number,
    reviewers: string[],
    requiredApprovals: number,
  ): Promise<ReviewSession> {
    const repoKey = `${owner}/${repo}`;
    const config = this.repos.get(repoKey);
    if (!config) throw new Error(`Repository ${repoKey} is not configured`);

    const sessionId = `review-${randomUUID().slice(0, 8)}`;
    const session: ReviewSession = {
      sessionId,
      repo: repoKey,
      prNumber,
      requiredApprovals,
      reviewers,
      reviews: [],
      status: 'pending',
      enshrined: false,
    };

    this.reviewSessions.set(sessionId, session);

    // Broadcast review request
    await this.broadcastMessage(config.paranetId, {
      app: APP_ID,
      type: 'review:requested',
      peerId: this.myPeerId,
      timestamp: Date.now(),
      repo: repoKey,
      prNumber,
      sessionId,
      reviewers,
      requiredApprovals,
    });

    this.log(`Created review session ${sessionId} for PR #${prNumber} (need ${requiredApprovals} approvals)`);
    return session;
  }

  async submitReview(
    sessionId: string,
    decision: 'approve' | 'request_changes' | 'comment',
    _comment?: string,
  ): Promise<ReviewSession> {
    const session = this.reviewSessions.get(sessionId);
    if (!session) throw new Error(`Review session ${sessionId} not found`);

    // Replace existing review from this peer, or append
    const existingIdx = session.reviews.findIndex(r => r.peerId === this.myPeerId);
    const reviewEntry = { peerId: this.myPeerId, decision, timestamp: Date.now() };
    if (existingIdx >= 0) {
      session.reviews[existingIdx] = reviewEntry;
    } else {
      session.reviews.push(reviewEntry);
    }

    // Check for consensus
    const approvals = session.reviews.filter(r => r.decision === 'approve').length;
    const rejections = session.reviews.filter(r => r.decision === 'request_changes').length;

    if (approvals >= session.requiredApprovals) {
      session.status = 'approved';
    } else if (rejections > 0) {
      session.status = 'changes_requested';
    }

    // Broadcast review
    const config = this.repos.get(session.repo);
    if (config) {
      await this.broadcastMessage(config.paranetId, {
        app: APP_ID,
        type: 'review:submitted',
        peerId: this.myPeerId,
        timestamp: Date.now(),
        repo: session.repo,
        prNumber: session.prNumber,
        sessionId,
        decision,
      });

      // If consensus reached, broadcast and enshrine
      if (session.status === 'approved' || session.status === 'changes_requested') {
        await this.broadcastMessage(config.paranetId, {
          app: APP_ID,
          type: 'review:consensus',
          peerId: this.myPeerId,
          timestamp: Date.now(),
          repo: session.repo,
          prNumber: session.prNumber,
          sessionId,
          outcome: session.status,
          signaturesCollected: approvals,
        });
      }
    }

    return session;
  }

  getReviewSession(sessionId: string): ReviewSession | undefined {
    return this.reviewSessions.get(sessionId);
  }

  // --- Invitations ---

  async sendInvitation(repoKey: string, peerId: string): Promise<Invitation> {
    const config = this.repos.get(repoKey);
    if (!config) throw new Error(`Repository ${repoKey} is not configured`);
    if (config.privacyLevel !== 'shared') {
      throw new Error(`Repository ${repoKey} must be in shared mode to send invitations`);
    }

    const invitationId = `inv-${randomUUID().slice(0, 8)}`;
    const invitation: Invitation = {
      invitationId,
      repoKey,
      paranetId: config.paranetId,
      fromPeerId: this.myPeerId,
      toPeerId: peerId,
      status: 'pending',
      direction: 'sent',
      createdAt: Date.now(),
    };

    this.sentInvitations.set(invitationId, invitation);

    await this.broadcastMessage(config.paranetId, {
      app: APP_ID,
      type: 'invite:sent',
      peerId: this.myPeerId,
      timestamp: Date.now(),
      invitationId,
      repo: repoKey,
      paranetId: config.paranetId,
      targetPeerId: peerId,
      nodeName: this.nodeName,
    });

    this.log(`Sent invitation ${invitationId} to ${peerId} for ${repoKey}`);
    return invitation;
  }

  async acceptInvitation(invitationId: string): Promise<Invitation> {
    const invitation = this.receivedInvitations.get(invitationId);
    if (!invitation) throw new Error(`Invitation ${invitationId} not found`);
    if (invitation.status !== 'pending') throw new Error(`Invitation ${invitationId} already ${invitation.status}`);

    invitation.status = 'accepted';

    // Register a minimal repo config so the collaborator can participate
    if (!this.repos.has(invitation.repoKey)) {
      const [owner, repo] = invitation.repoKey.split('/');
      const repoConfig: RepoConfig = {
        owner,
        repo,
        pollIntervalMs: 300_000,
        syncScope: [],
        paranetId: invitation.paranetId,
        privacyLevel: 'shared',
      };
      this.repos.set(invitation.repoKey, repoConfig);
      this.saveToDisk();
    }

    // Subscribe to the paranet
    this.subscribeToParanet(invitation.paranetId);

    await this.broadcastMessage(invitation.paranetId, {
      app: APP_ID,
      type: 'invite:accepted',
      peerId: this.myPeerId,
      timestamp: Date.now(),
      invitationId,
      repo: invitation.repoKey,
      paranetId: invitation.paranetId,
      nodeName: this.nodeName,
    });

    this.log(`Accepted invitation ${invitationId} for ${invitation.repoKey}`);
    return invitation;
  }

  revokeInvitation(invitationId: string): void {
    const invitation = this.sentInvitations.get(invitationId);
    if (!invitation) throw new Error(`Invitation ${invitationId} not found`);
    invitation.status = 'revoked';
    this.sentInvitations.delete(invitationId);
    this.log(`Revoked invitation ${invitationId}`);
  }

  async declineInvitation(invitationId: string): Promise<Invitation> {
    const invitation = this.receivedInvitations.get(invitationId);
    if (!invitation) throw new Error(`Invitation ${invitationId} not found`);
    if (invitation.status !== 'pending') throw new Error(`Invitation ${invitationId} already ${invitation.status}`);

    invitation.status = 'declined';

    await this.broadcastMessage(invitation.paranetId, {
      app: APP_ID,
      type: 'invite:declined',
      peerId: this.myPeerId,
      timestamp: Date.now(),
      invitationId,
      repo: invitation.repoKey,
    });

    this.log(`Declined invitation ${invitationId} for ${invitation.repoKey}`);
    return invitation;
  }

  getInvitations(repoKey?: string): { sent: Invitation[]; received: Invitation[] } {
    let sent = [...this.sentInvitations.values()];
    let received = [...this.receivedInvitations.values()];
    if (repoKey) {
      sent = sent.filter(i => i.repoKey === repoKey);
      received = received.filter(i => i.repoKey === repoKey);
    }
    return { sent, received };
  }

  getCollaborators(repoKey: string): PeerInfo[] {
    const config = this.repos.get(repoKey);
    if (!config) return [];
    return [...this.peers.values()].filter(p =>
      p.peerId !== this.myPeerId && p.repos.includes(repoKey),
    );
  }

  // --- GossipSub ---

  private findRepoByParanetId(paranetId: string): RepoConfig | undefined {
    for (const config of this.repos.values()) {
      if (config.paranetId === paranetId) return config;
    }
    return undefined;
  }

  private subscribeToParanet(paranetId: string): void {
    const appTopic = `dkg/paranet/${paranetId}/app`;
    if (this.subscribedTopics.has(appTopic)) return;

    this.agent.gossip.subscribe(appTopic);
    this.agent.gossip.onMessage(appTopic, this.gossipHandler);
    this.subscribedTopics.add(appTopic);
    this.log(`Subscribed to ${appTopic}`);
  }

  private async broadcastMessage(paranetId: string, msg: AppMessage): Promise<void> {
    const topic = `dkg/paranet/${paranetId}/app`;
    try {
      await this.agent.gossip.publish(topic, encodeMessage(msg));
    } catch (err: any) {
      this.log(`Failed to broadcast ${msg.type}: ${err.message}`);
    }
  }

  private handleGossipMessage(_topic: string, data: Uint8Array, from: string): void {
    if (from === this.myPeerId) return;
    const msg = decodeMessage(data);
    if (!msg) return;

    switch (msg.type) {
      case 'review:submitted': {
        const session = this.reviewSessions.get(msg.sessionId);
        if (session) {
          // Replace existing review from this peer, or append
          const existingIdx = session.reviews.findIndex(r => r.peerId === msg.peerId);
          const reviewEntry = { peerId: msg.peerId, decision: msg.decision, timestamp: msg.timestamp };
          if (existingIdx >= 0) {
            session.reviews[existingIdx] = reviewEntry;
          } else {
            session.reviews.push(reviewEntry);
          }
          // Recompute consensus status
          const approvals = session.reviews.filter(r => r.decision === 'approve').length;
          const rejections = session.reviews.filter(r => r.decision === 'request_changes').length;
          if (approvals >= session.requiredApprovals) {
            session.status = 'approved';
          } else if (rejections > 0) {
            session.status = 'changes_requested';
          }
          this.log(`Received review from ${msg.peerId} for session ${msg.sessionId}: ${msg.decision}`);
        }
        break;
      }

      case 'review:requested': {
        // Store session if we're a requested reviewer
        if (msg.reviewers.includes(this.myPeerId) && !this.reviewSessions.has(msg.sessionId)) {
          this.reviewSessions.set(msg.sessionId, {
            sessionId: msg.sessionId,
            repo: msg.repo,
            prNumber: msg.prNumber,
            requiredApprovals: msg.requiredApprovals,
            reviewers: msg.reviewers,
            reviews: [],
            status: 'pending',
            enshrined: false,
          });
          this.log(`Review requested: session ${msg.sessionId} for PR #${msg.prNumber}`);
        }
        break;
      }

      case 'node:joined': {
        const peer = this.peers.get(msg.peerId) ?? { peerId: msg.peerId, connected: true, lastSeen: msg.timestamp, repos: [] };
        peer.connected = true;
        peer.lastSeen = msg.timestamp;
        if (msg.nodeName) peer.name = msg.nodeName;
        if (msg.repo && !peer.repos.includes(msg.repo)) peer.repos.push(msg.repo);
        this.peers.set(msg.peerId, peer);
        this.log(`Node ${msg.peerId} joined ${msg.repo}`);
        break;
      }

      case 'node:left': {
        const peer = this.peers.get(msg.peerId);
        if (peer) {
          peer.repos = peer.repos.filter(r => r !== msg.repo);
          if (peer.repos.length === 0) peer.connected = false;
        }
        this.log(`Node ${msg.peerId} left ${msg.repo}`);
        break;
      }

      case 'sync:announce':
        this.log(`Node ${msg.peerId} synced ${msg.repo}: ${msg.quadsWritten} quads`);
        break;

      case 'invite:sent': {
        // Store as received invitation if we are the target
        if (msg.targetPeerId === this.myPeerId && !this.receivedInvitations.has(msg.invitationId)) {
          this.receivedInvitations.set(msg.invitationId, {
            invitationId: msg.invitationId,
            repoKey: msg.repo,
            paranetId: msg.paranetId,
            fromPeerId: msg.peerId,
            fromNodeName: msg.nodeName,
            toPeerId: this.myPeerId,
            status: 'pending',
            direction: 'received',
            createdAt: msg.timestamp,
          });
          this.log(`Received invitation ${msg.invitationId} from ${msg.peerId} for ${msg.repo}`);
        }
        break;
      }

      case 'invite:accepted': {
        const sent = this.sentInvitations.get(msg.invitationId);
        if (sent) {
          sent.status = 'accepted';
          this.log(`Invitation ${msg.invitationId} accepted by ${msg.peerId}`);
        }
        break;
      }

      case 'invite:declined': {
        const sent = this.sentInvitations.get(msg.invitationId);
        if (sent) {
          sent.status = 'declined';
          this.log(`Invitation ${msg.invitationId} declined by ${msg.peerId}`);
        }
        break;
      }

      case 'ping': {
        const peer = this.peers.get(msg.peerId) ?? { peerId: msg.peerId, connected: true, lastSeen: msg.timestamp, repos: [] };
        peer.connected = true;
        peer.lastSeen = msg.timestamp;
        peer.repos = msg.repos ?? peer.repos;
        this.peers.set(msg.peerId, peer);
        break;
      }

      case 'session:started': {
        this.activity.mirrorRemoteSession({
          sessionId: msg.sessionId,
          agentName: msg.agent,
          peerId: msg.peerId,
          goal: msg.goal,
          startedAt: msg.timestamp,
          repoKey: msg.repo,
        });
        this.log(`Remote session started: ${msg.agent} (${msg.peerId.slice(0, 8)})`);
        break;
      }

      case 'session:ended': {
        this.activity.mirrorRemoteSessionEnd(msg.sessionId, msg.summary);
        break;
      }

      case 'session:heartbeat': {
        this.activity.mirrorRemoteHeartbeat(msg.sessionId);
        break;
      }

      case 'claim:created': {
        this.activity.mirrorRemoteClaim(msg.claimId, msg.file, msg.peerId, msg.agent, msg.sessionId ?? '', msg.repo);
        break;
      }

      case 'claim:released': {
        this.activity.mirrorRemoteClaimRelease(msg.claimId);
        break;
      }

      case 'decision:recorded': {
        this.activity.mirrorRemoteDecision({
          decisionId: msg.decisionId,
          summary: msg.summary,
          peerId: msg.peerId,
          agentName: msg.agent,
          createdAt: msg.timestamp,
          repoKey: msg.repo,
        });
        break;
      }

      case 'claim:conflict': {
        this.log(`Claim conflict: ${msg.file} (${msg.existingAgent} vs ${msg.claimingAgent})`);
        break;
      }

      case 'annotation:added': {
        this.activity.mirrorRemoteAnnotation({
          annotationId: msg.annotationId,
          targetUri: msg.targetUri,
          kind: msg.kind,
          content: msg.content,
          peerId: msg.peerId,
          agentName: msg.agent,
          createdAt: msg.timestamp,
        });
        break;
      }
    }
  }

  private async broadcastPing(): Promise<void> {
    for (const config of this.repos.values()) {
      await this.broadcastMessage(config.paranetId, {
        app: APP_ID,
        type: 'ping',
        peerId: this.myPeerId,
        timestamp: Date.now(),
        repos: [...this.repos.keys()],
      });
    }
  }

  private onSyncComplete(repoKey: string, scope: string[], quadsWritten: number): void {
    const config = this.repos.get(repoKey);
    if (!config) return;

    config.lastSyncAt = new Date().toISOString();
    this.saveToDisk();

    this.broadcastMessage(config.paranetId, {
      app: APP_ID,
      type: 'sync:announce',
      peerId: this.myPeerId,
      timestamp: Date.now(),
      repo: repoKey,
      scope,
      quadsWritten,
    }).catch(() => {});
  }

  // --- Agent Activity ---

  async startAgentSession(
    repoKey: string,
    agentName: string,
    opts?: { goal?: string; relatedPr?: number; relatedIssue?: number },
  ): Promise<AgentSession> {
    const config = this.repos.get(repoKey);
    if (!config) throw new Error(`Repository ${repoKey} is not configured`);

    const session = this.activity.startSession(agentName, this.myPeerId, opts);
    session.repoKey = repoKey;

    // Write RDF to workspace
    const graph = `did:dkg:paranet:${config.paranetId}`;
    const quads = this.activity.generateSessionQuads(session, config.owner, config.repo, graph);
    await this.writeToWorkspace(config.paranetId, quads);

    // Broadcast if shared
    if (config.privacyLevel === 'shared') {
      await this.broadcastMessage(config.paranetId, {
        app: APP_ID,
        type: 'session:started',
        peerId: this.myPeerId,
        timestamp: Date.now(),
        repo: repoKey,
        sessionId: session.sessionId,
        agent: agentName,
        goal: opts?.goal,
      });
    }

    return session;
  }

  heartbeatAgentSession(sessionId: string): AgentSession {
    return this.activity.heartbeatSession(sessionId);
  }

  async addSessionFiles(
    sessionId: string,
    files: string[],
    repoKey: string,
  ): Promise<{ totalFiles: number; warnings: Array<{ file: string; claimedBy: string; since: string }> }> {
    const result = this.activity.addModifiedFiles(sessionId, files, repoKey);
    return { totalFiles: result.session.modifiedFiles.length, warnings: result.warnings };
  }

  async endAgentSession(
    sessionId: string,
    repoKey: string,
    summary?: string,
  ): Promise<{ session: AgentSession; releasedClaims: string[] }> {
    const config = this.repos.get(repoKey);
    // Snapshot claims before they are released by endSession
    const claimsBeforeEnd = this.activity.getActiveClaims(repoKey)
      .filter(c => c.sessionId === sessionId);
    const result = this.activity.endSession(sessionId, summary);

    // Write final session RDF
    if (config) {
      const graph = `did:dkg:paranet:${config.paranetId}`;
      const quads = this.activity.generateSessionQuads(result.session, config.owner, config.repo, graph);
      await this.writeToWorkspace(config.paranetId, quads);

      if (config.privacyLevel === 'shared') {
        // Broadcast claim:released for each released claim so remote peers clean up
        for (const claim of claimsBeforeEnd) {
          if (result.releasedClaims.includes(claim.claimId)) {
            await this.broadcastMessage(config.paranetId, {
              app: APP_ID,
              type: 'claim:released',
              peerId: this.myPeerId,
              timestamp: Date.now(),
              repo: repoKey,
              claimId: claim.claimId,
              file: claim.filePath,
            });
          }
        }

        const durationSec = Math.floor((Date.now() - result.session.startedAt) / 1000);
        await this.broadcastMessage(config.paranetId, {
          app: APP_ID,
          type: 'session:ended',
          peerId: this.myPeerId,
          timestamp: Date.now(),
          repo: repoKey,
          sessionId,
          agent: result.session.agentName,
          summary,
          duration: durationSec,
          filesModified: result.session.modifiedFiles.length,
        });
      }
    }

    return result;
  }

  async claimFiles(
    repoKey: string,
    filePaths: string[],
    sessionId: string,
    agentName: string,
  ): Promise<ClaimResult> {
    const config = this.repos.get(repoKey);
    if (!config) throw new Error(`Repository ${repoKey} is not configured`);

    const result = this.activity.claimFiles(filePaths, sessionId, agentName, this.myPeerId, repoKey);

    // Write RDF for successful claims
    for (const claim of result.claimed) {
      const graph = `did:dkg:paranet:${config.paranetId}`;
      const quads = this.activity.generateClaimQuads(claim, config.owner, config.repo, graph);
      await this.writeToWorkspace(config.paranetId, quads);

      if (config.privacyLevel === 'shared') {
        await this.broadcastMessage(config.paranetId, {
          app: APP_ID,
          type: 'claim:created',
          peerId: this.myPeerId,
          timestamp: Date.now(),
          repo: repoKey,
          claimId: claim.claimId,
          file: claim.filePath,
          agent: agentName,
          sessionId,
        });
      }
    }

    // Broadcast conflicts
    for (const conflict of result.conflicts) {
      if (config.privacyLevel === 'shared') {
        await this.broadcastMessage(config.paranetId, {
          app: APP_ID,
          type: 'claim:conflict',
          peerId: this.myPeerId,
          timestamp: Date.now(),
          repo: repoKey,
          file: conflict.file,
          claimingAgent: agentName,
          existingAgent: conflict.existingClaim.agentName,
        });
      }
    }

    return result;
  }

  releaseClaim(claimId: string): CodeClaim | undefined {
    return this.activity.releaseClaim(claimId);
  }

  getActiveClaims(repoKey?: string): CodeClaim[] {
    return this.activity.getActiveClaims(repoKey);
  }

  async recordDecision(
    repoKey: string,
    input: {
      summary: string;
      rationale: string;
      alternatives?: string[];
      affectedFiles: string[];
      agentName: string;
      sessionId?: string;
    },
  ): Promise<Decision> {
    const config = this.repos.get(repoKey);
    if (!config) throw new Error(`Repository ${repoKey} is not configured`);

    const decision = this.activity.recordDecision({
      ...input,
      peerId: this.myPeerId,
    });
    decision.repoKey = repoKey;

    // Write RDF
    const graph = `did:dkg:paranet:${config.paranetId}`;
    const quads = this.activity.generateDecisionQuads(decision, config.owner, config.repo, graph);
    await this.writeToWorkspace(config.paranetId, quads);

    if (config.privacyLevel === 'shared') {
      await this.broadcastMessage(config.paranetId, {
        app: APP_ID,
        type: 'decision:recorded',
        peerId: this.myPeerId,
        timestamp: Date.now(),
        repo: repoKey,
        decisionId: decision.decisionId,
        summary: decision.summary,
        agent: decision.agentName,
      });
    }

    return decision;
  }

  async addAnnotation(
    repoKey: string,
    input: {
      targetUri: string;
      kind: 'finding' | 'suggestion' | 'warning' | 'note';
      content: string;
      agentName: string;
      sessionId?: string;
    },
  ): Promise<Annotation> {
    const config = this.repos.get(repoKey);
    if (!config) throw new Error(`Repository ${repoKey} is not configured`);

    const annotation = this.activity.addAnnotation({
      ...input,
      peerId: this.myPeerId,
    });

    // Write RDF
    const graph = `did:dkg:paranet:${config.paranetId}`;
    const quads = this.activity.generateAnnotationQuads(annotation, config.owner, config.repo, graph);
    await this.writeToWorkspace(config.paranetId, quads);

    // Broadcast if shared
    if (config.privacyLevel === 'shared') {
      await this.broadcastMessage(config.paranetId, {
        app: APP_ID,
        type: 'annotation:added',
        peerId: this.myPeerId,
        timestamp: Date.now(),
        repo: repoKey,
        annotationId: annotation.annotationId,
        targetUri: annotation.targetUri,
        kind: annotation.kind,
        content: annotation.content,
        agent: input.agentName,
      });
    }

    return annotation;
  }

  getAgentSessions(opts?: { status?: string }): AgentSession[] {
    return this.activity.getSessions(opts);
  }

  getDecisions(repoKey?: string): Decision[] {
    return this.activity.getDecisions(repoKey);
  }

  getAgentActivity(repoKey?: string, limit?: number): ActivityEntry[] {
    return this.activity.getActivity(limit, repoKey);
  }

  // --- Cleanup ---

  destroy(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    for (const topic of this.subscribedTopics) {
      this.agent.gossip.offMessage(topic, this.gossipHandler);
    }
    this.subscribedTopics.clear();

    this.syncEngine.destroy();
  }
}
