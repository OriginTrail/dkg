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
import { SyncEngine, type RepoSyncConfig, type SyncScope, type SyncJob, type WebhookResult } from './sync-engine.js';
import { APP_ID, encodeMessage, decodeMessage, type AppMessage, type MessageType } from './protocol.js';
import { paranetId as makeParanetId, type Quad } from '../rdf/uri.js';

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
  lastSyncAt?: string;
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

export class GitHubCollabCoordinator {
  readonly myPeerId: string;
  private readonly agent: DKGAgent;
  private readonly nodeName: string;
  private readonly repos = new Map<string, RepoConfig>();
  private readonly syncEngine: SyncEngine;
  private readonly reviewSessions = new Map<string, ReviewSession>();
  private readonly subscribedTopics = new Set<string>();
  private readonly gossipHandler: (topic: string, data: Uint8Array, from: string) => void;
  private readonly log: (msg: string) => void;
  private pingTimer?: ReturnType<typeof setInterval>;

  constructor(agent: DKGAgent, config?: { name?: string }, log?: (msg: string) => void) {
    this.agent = agent;
    this.myPeerId = agent.peerId;
    this.nodeName = config?.name ?? agent.peerId.slice(0, 8);
    this.log = log ?? ((msg: string) => console.log(`[github-collab] ${msg}`));

    this.syncEngine = new SyncEngine(
      (paranetId, quads) => this.writeToWorkspace(paranetId, quads),
      (repoKey, scope, quadsWritten) => this.onSyncComplete(repoKey, scope, quadsWritten),
    );

    this.gossipHandler = (topic: string, data: Uint8Array, from: string) => {
      this.handleGossipMessage(topic, data, from);
    };

    // Ping timer for presence tracking
    this.pingTimer = setInterval(() => this.broadcastPing(), 60_000);
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
  }): Promise<{ paranetId: string; repoKey: string }> {
    const repoKey = `${config.owner}/${config.repo}`;
    const pId = config.paranetId ?? makeParanetId(config.owner, config.repo);

    const repoConfig: RepoConfig = {
      owner: config.owner,
      repo: config.repo,
      githubToken: config.githubToken,
      webhookSecret: config.webhookSecret,
      pollIntervalMs: config.pollIntervalMs ?? 300_000,
      syncScope: config.syncScope ?? ['pull_requests', 'issues', 'reviews', 'commits'],
      paranetId: pId,
    };

    this.repos.set(repoKey, repoConfig);

    // Set up sync engine if we have a token
    if (config.githubToken) {
      this.syncEngine.addRepo({
        ...repoConfig,
        githubToken: config.githubToken,
      } as RepoSyncConfig);
    }

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

    this.log(`Added repo ${repoKey} → paranet ${pId}`);
    return { paranetId: pId, repoKey };
  }

  removeRepo(owner: string, repo: string): void {
    const repoKey = `${owner}/${repo}`;
    const config = this.repos.get(repoKey);
    if (!config) return;

    this.syncEngine.removeRepo(owner, repo);
    this.repos.delete(repoKey);
    this.log(`Removed repo ${repoKey}`);
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
    await this.agent.writeToWorkspace(paranetId, quads as any[]);
  }

  async enshrineData(
    paranetId: string,
    selection: 'all' | { rootEntities: string[] },
    options?: { clearWorkspaceAfter?: boolean },
  ): Promise<any> {
    return this.agent.enshrineFromWorkspace(paranetId, selection, options);
  }

  // --- Query ---

  async query(sparql: string, repoKey?: string, includeWorkspace = true): Promise<any> {
    const opts: any = { includeWorkspace };
    if (repoKey) {
      const config = this.repos.get(repoKey);
      if (config) opts.paranetId = config.paranetId;
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

    // Auto-enshrine on PR merge/close
    if (result.ok && result.quadsWritten > 0) {
      if (event === 'pull_request' && (action === 'closed' || action === 'merged')) {
        const owner = repoData.owner.login;
        const repo = repoData.name;
        const prNumber = payload.pull_request?.number;
        const config = this.repos.get(`${owner}/${repo}`);
        if (config && prNumber) {
          const prEntityUri = `urn:github:${owner}/${repo}/pr/${prNumber}`;
          this.enshrineData(config.paranetId, { rootEntities: [prEntityUri] }, { clearWorkspaceAfter: false })
            .catch(err => this.log(`Enshrine failed for PR #${prNumber}: ${err.message}`));
        }
      }
    }

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

    // Record the review
    session.reviews.push({
      peerId: this.myPeerId,
      decision,
      timestamp: Date.now(),
    });

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

  // --- GossipSub ---

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
          const alreadyReviewed = session.reviews.some(r => r.peerId === msg.peerId);
          if (!alreadyReviewed) {
            session.reviews.push({
              peerId: msg.peerId,
              decision: msg.decision,
              timestamp: msg.timestamp,
            });
            const approvals = session.reviews.filter(r => r.decision === 'approve').length;
            if (approvals >= session.requiredApprovals) {
              session.status = 'approved';
            }
            this.log(`Received review from ${msg.peerId} for session ${msg.sessionId}: ${msg.decision}`);
          }
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

      case 'node:joined':
        this.log(`Node ${msg.peerId} joined ${msg.repo}`);
        break;

      case 'node:left':
        this.log(`Node ${msg.peerId} left ${msg.repo}`);
        break;

      case 'sync:announce':
        this.log(`Node ${msg.peerId} synced ${msg.repo}: ${msg.quadsWritten} quads`);
        break;

      case 'ping':
        // Presence tracking handled externally if needed
        break;
    }
  }

  private async broadcastPing(): Promise<void> {
    const repos = [...this.repos.keys()];
    if (repos.length === 0) return;

    // Send ping on first repo's paranet (all repos share presence)
    const firstConfig = this.repos.values().next().value;
    if (firstConfig) {
      await this.broadcastMessage(firstConfig.paranetId, {
        app: APP_ID,
        type: 'ping',
        peerId: this.myPeerId,
        timestamp: Date.now(),
        repos,
      });
    }
  }

  private onSyncComplete(repoKey: string, scope: string[], quadsWritten: number): void {
    const config = this.repos.get(repoKey);
    if (!config) return;

    config.lastSyncAt = new Date().toISOString();

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

  // --- Cleanup ---

  destroy(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }

    for (const topic of this.subscribedTopics) {
      this.agent.gossip.offMessage(topic, this.gossipHandler);
    }
    this.subscribedTopics.clear();

    this.syncEngine.destroy();
  }
}
