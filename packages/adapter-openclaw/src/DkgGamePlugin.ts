/**
 * DkgGamePlugin — OriginTrail Game integration for OpenClaw agents.
 *
 * Registers game tools (lobby, join, create, vote, autopilot, etc.)
 * and a GameService that autonomously plays the game when autopilot
 * is engaged.
 *
 * All game API calls route through GameClient → daemon HTTP API at
 * /api/apps/origin-trail-game/*.  Game history is queried from the
 * DKG context graph via SPARQL.
 *
 * Agent consultation for autopilot decisions uses the channel bridge
 * (processInbound with identity "game-autopilot") to route through
 * a separate OpenClaw session — the user's normal chat is never
 * polluted with turn-by-turn decisions.
 */

import type { DkgDaemonClient } from './dkg-client.js';
import type {
  DkgOpenClawConfig,
  OpenClawPluginApi,
  OpenClawTool,
  OpenClawToolResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback to consult the agent LLM for a strategic game decision. */
export type ConsultAgentFn = (
  prompt: string,
  correlationId: string,
) => Promise<string>;

/** Minimal game config. */
export type GameConfig = NonNullable<DkgOpenClawConfig['game']>;

// Game API response shapes (mirrors origin-trail-game handler output)
interface SwarmState {
  id: string;
  name: string;
  leaderId: string;
  leaderName: string;
  maxPlayers: number;
  playerCount: number;
  players: Array<{ id: string; name: string; isLeader: boolean }>;
  status: 'recruiting' | 'traveling' | 'finished';
  currentTurn: number;
  gameState: GameState | null;
  voteStatus: {
    votes: Array<{ player: string; action: string; hasVoted: boolean; isAlive: boolean }>;
    timeRemaining: number;
    allVoted: boolean;
  } | null;
  lastTurn: { turn: number; action: string; message: string } | null;
}

interface GameState {
  sessionId: string;
  player: string;
  epochs: number;
  trainingTokens: number;
  apiCredits: number;
  computeUnits: number;
  modelWeights: number;
  trac: number;
  month: number;
  day: number;
  party: Array<{ id: string; name: string; health: number; alive: boolean }>;
  status: 'active' | 'won' | 'lost';
  moveCount: number;
  lastEvent?: { id: string; type: string; description: string; affectedMember?: string };
}

interface LocationInfo {
  id: string;
  name: string;
  epoch: number;
  type: 'start' | 'hub' | 'bottleneck' | 'landmark' | 'end';
  description?: string;
  difficulty?: number;
  tollPrice?: number;
  trades?: Array<{ item: string; price: number; stock: number }>;
}

type ActionType = 'advance' | 'upgradeSkills' | 'syncMemory' | 'forceBottleneck' | 'payToll' | 'trade';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GAME_API = '/api/apps/origin-trail-game';
const OT = 'https://origintrail-game.dkg.io/';
const GAME_PARANET = 'origin-trail-game';

const VALID_ACTIONS: ActionType[] = [
  'advance', 'upgradeSkills', 'syncMemory', 'forceBottleneck', 'payToll', 'trade',
];

/** Actions ordered for natural-language fallback: specific actions first, generic 'advance' last. */
const NL_FALLBACK_ORDER: ActionType[] = [
  'upgradeSkills', 'syncMemory', 'forceBottleneck', 'payToll', 'trade', 'advance',
];

// ---------------------------------------------------------------------------
// GameClient — typed HTTP wrapper for game API endpoints
// ---------------------------------------------------------------------------

class GameClient {
  private readonly baseUrl: string;
  private readonly authToken: string | undefined;
  private readonly timeoutMs: number;

  constructor(client: DkgDaemonClient) {
    this.baseUrl = client.baseUrl;
    this.authToken = client.getAuthToken();
    this.timeoutMs = 30_000;
  }

  async getLobby(): Promise<{ openSwarms: SwarmState[]; mySwarms: SwarmState[] }> {
    return this.get(`${GAME_API}/lobby`);
  }

  async getSwarm(swarmId: string): Promise<SwarmState> {
    return this.get(`${GAME_API}/swarm/${encodeURIComponent(swarmId)}`);
  }

  async getLocations(): Promise<{ locations: LocationInfo[] }> {
    return this.get(`${GAME_API}/locations`);
  }

  async getLeaderboard(): Promise<{ entries: unknown[] }> {
    return this.get(`${GAME_API}/leaderboard`);
  }

  async getInfo(): Promise<Record<string, unknown>> {
    return this.get(`${GAME_API}/info`);
  }

  async createSwarm(playerName: string, swarmName: string, maxPlayers?: number): Promise<SwarmState> {
    return this.post(`${GAME_API}/create`, { playerName, swarmName, maxPlayers });
  }

  async joinSwarm(swarmId: string, playerName: string): Promise<SwarmState> {
    return this.post(`${GAME_API}/join`, { swarmId, playerName });
  }

  async startExpedition(swarmId: string): Promise<SwarmState> {
    return this.post(`${GAME_API}/start`, { swarmId });
  }

  async castVote(swarmId: string, voteAction: string, params?: Record<string, unknown>): Promise<SwarmState> {
    return this.post(`${GAME_API}/vote`, { swarmId, voteAction, params });
  }

  async forceResolve(swarmId: string): Promise<SwarmState> {
    return this.post(`${GAME_API}/force-resolve`, { swarmId });
  }

  // HTTP primitives (same pattern as DkgDaemonClient)
  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...this.authHeaders() },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Game API ${path} responded ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Game API ${path} responded ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  private authHeaders(): Record<string, string> {
    if (!this.authToken) return {};
    return { Authorization: `Bearer ${this.authToken}` };
  }
}

// ---------------------------------------------------------------------------
// GameService — background polling loop + agent consultation
// ---------------------------------------------------------------------------

class GameService {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private swarmId: string | null = null;
  private lastSeenTurn = -1;
  private hasVotedThisTurn = false;
  private tickInProgress = false;
  private strategyHint = '';
  private running = false;
  /** Cached locations — fetched once on start. */
  private locations: LocationInfo[] = [];
  /** Last known game result for status queries. */
  lastResult: { status: string; message: string } | null = null;

  constructor(
    private readonly gameClient: GameClient,
    private readonly dkgClient: DkgDaemonClient,
    private readonly consultAgent: ConsultAgentFn | undefined,
    private readonly config: GameConfig,
    private readonly log: OpenClawPluginApi['logger'],
  ) {}

  get isRunning(): boolean { return this.running; }
  get activeSwarmId(): string | null { return this.swarmId; }

  async start(swarmId: string, strategyHint?: string): Promise<void> {
    if (this.running) {
      throw new Error(`Autopilot already running for swarm ${this.swarmId}`);
    }
    if (!this.consultAgent) {
      throw new Error(
        'Autopilot requires the channel bridge (channel.enabled: true) for agent consultation. ' +
        'Use game_vote for manual play instead.',
      );
    }

    this.swarmId = swarmId;
    this.strategyHint = strategyHint ?? '';
    this.lastSeenTurn = -1;
    this.hasVotedThisTurn = false;
    this.lastResult = null;
    this.running = true;

    // Cache locations for context building
    try {
      const { locations } = await this.gameClient.getLocations();
      this.locations = locations;
    } catch { this.locations = []; }

    const intervalMs = this.config.pollIntervalMs ?? 2000;
    this.pollTimer = setInterval(() => {
      void this.tick().catch(err => {
        this.log.warn?.(`[dkg-game] Tick error: ${err.message}`);
      });
    }, intervalMs);

    this.log.info?.(`[dkg-game] Autopilot started for swarm ${swarmId} (poll every ${intervalMs}ms)`);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    const wasRunning = this.running;
    this.running = false;
    this.swarmId = null;
    if (wasRunning) {
      this.log.info?.('[dkg-game] Autopilot stopped');
    }
  }

  private async tick(): Promise<void> {
    if (!this.swarmId || !this.running) return;
    if (this.tickInProgress) return; // Guard against concurrent ticks
    this.tickInProgress = true;

    try {
      let state: SwarmState;
      try {
        state = await this.gameClient.getSwarm(this.swarmId);
      } catch (err: any) {
        this.log.warn?.(`[dkg-game] Failed to fetch swarm state: ${err.message}`);
        return;
      }

      // Game finished?
      if (state.status === 'finished' || state.gameState?.status === 'won' || state.gameState?.status === 'lost') {
        const outcome = state.gameState?.status ?? 'finished';
        const gs = state.gameState;
        const msg = outcome === 'won'
          ? `Game won! Reached epoch ${gs?.epochs ?? '?'} with ${gs?.party.filter(m => m.alive).length ?? '?'} survivors.`
          : `Game lost. Reached epoch ${gs?.epochs ?? '?'}, month ${gs?.month ?? '?'}.`;
        this.lastResult = { status: outcome, message: msg };
        this.log.info?.(`[dkg-game] Game ended: ${msg}`);
        await this.stop();
        return;
      }

      // Still recruiting — nothing to do
      if (state.status !== 'traveling' || !state.gameState) return;

      // New turn detected?
      if (state.currentTurn > this.lastSeenTurn) {
        this.lastSeenTurn = state.currentTurn;
        this.hasVotedThisTurn = false;
      }

      // Already voted this turn?
      if (this.hasVotedThisTurn) {
        // If we're leader and all votes are in (or deadline approaching), force-resolve
        await this.maybeForceResolve(state);
        return;
      }

      await this.makeDecision(state);
    } finally {
      this.tickInProgress = false;
    }
  }

  private async makeDecision(state: SwarmState): Promise<void> {
    if (!this.swarmId || !this.consultAgent) return;
    const gs = state.gameState!;

    try {
      // 1. Query DKG context graph for full turn history
      const turnHistory = await this.queryTurnHistory(this.swarmId);

      // 2. Build decision context prompt
      const prompt = this.buildDecisionPrompt(state, gs, turnHistory);

      // 3. Consult agent with timeout
      const correlationId = `game-turn-${this.swarmId}-${state.currentTurn}-${Date.now()}`;
      const timeoutMs = this.config.decisionTimeoutMs ?? 15_000;

      let agentReply: string;
      try {
        agentReply = await withTimeout(
          this.consultAgent(prompt, correlationId),
          timeoutMs,
        );
      } catch (err: any) {
        // Timeout or agent error — use fallback action
        this.log.warn?.(`[dkg-game] Agent consultation failed (${err.message}), using fallback action`);
        agentReply = 'ACTION: advance PARAMS: {"intensity": 1}';
      }

      // 4. Parse agent response
      const { action, params } = parseActionResponse(agentReply);
      this.log.info?.(`[dkg-game] Turn ${state.currentTurn}: ${action}${params ? ` (${JSON.stringify(params)})` : ''}`);

      // 5. Submit vote
      await this.gameClient.castVote(this.swarmId, action, params);
      this.hasVotedThisTurn = true;

    } catch (err: any) {
      this.log.warn?.(`[dkg-game] Decision failed for turn ${state.currentTurn}: ${err.message}`);
      // Try fallback vote
      try {
        await this.gameClient.castVote(this.swarmId!, 'advance', { intensity: 1 });
        this.hasVotedThisTurn = true;
        this.log.info?.('[dkg-game] Fallback vote submitted: advance(1)');
      } catch (voteErr: any) {
        this.log.warn?.(`[dkg-game] Fallback vote also failed: ${voteErr.message}`);
      }
    }
  }

  private async maybeForceResolve(state: SwarmState): Promise<void> {
    if (!this.swarmId) return;
    // Force-resolve if all votes are in or time is running low
    const vs = state.voteStatus;
    if (!vs) return;
    if (vs.allVoted || vs.timeRemaining < 3000) {
      try {
        await this.gameClient.forceResolve(this.swarmId);
        this.log.info?.(`[dkg-game] Force-resolved turn ${state.currentTurn}`);
      } catch {
        // Likely not the leader or already resolved — ignore
      }
    }
  }

  // ---------------------------------------------------------------------------
  // DKG context graph query — full turn history
  // ---------------------------------------------------------------------------

  private async queryTurnHistory(swarmId: string): Promise<TurnHistoryEntry[]> {
    const swarmUri = `${OT}swarm/${encodeURIComponent(swarmId)}`;
    const sparql = `SELECT ?turn ?action ?gameState WHERE {
      ?t a <${OT}TurnResult> ;
         <${OT}swarm> <${swarmUri}> ;
         <${OT}turn> ?turn ;
         <${OT}winningAction> ?action ;
         <${OT}gameState> ?gameState .
    }
    ORDER BY ASC(?turn)`;

    try {
      const result = await this.dkgClient.query(sparql, { paranetId: GAME_PARANET });
      const bindings: any[] = result?.result?.bindings ?? result?.results?.bindings ?? result?.bindings ?? [];
      return bindings.map((b: any) => ({
        turn: parseInt(bv(b.turn) ?? '0', 10),
        action: bv(b.action) ?? 'unknown',
        gameState: tryParseJson(bv(b.gameState)),
      }));
    } catch (err: any) {
      this.log.warn?.(`[dkg-game] Turn history query failed: ${err.message}`);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Decision context prompt builder
  // ---------------------------------------------------------------------------

  private buildDecisionPrompt(
    swarm: SwarmState,
    gs: GameState,
    turnHistory: TurnHistoryEntry[],
  ): string {
    const currentLoc = this.findCurrentLocation(gs.epochs);
    const upcoming = this.getUpcomingLocations(gs.epochs, 3);
    const aliveCount = gs.party.filter(m => m.alive).length;

    const lines: string[] = [
      `[ORIGIN TRAIL GAME — TURN ${swarm.currentTurn} — ACTION REQUIRED]`,
      '',
      `Current epoch: ${gs.epochs}/1000 | Month: ${gs.month}, Day: ${gs.day}`,
      `Party: ${aliveCount} alive of ${gs.party.length}`,
      ...gs.party.map(m => `  ${m.name}: HP ${m.health}/100 ${m.alive ? '' : '(DEAD)'}`),
      '',
      '--- Resources ---',
      `Training tokens: ${gs.trainingTokens}`,
      `API credits: ${gs.apiCredits}`,
      `Compute units: ${gs.computeUnits}`,
      `Model weights: ${gs.modelWeights}`,
      `TRAC: ${gs.trac}`,
      '',
    ];

    // Current location
    if (currentLoc) {
      lines.push(`--- Current Location ---`);
      lines.push(`${currentLoc.name} (${currentLoc.type}, epoch ${currentLoc.epoch})`);
      if (currentLoc.description) lines.push(currentLoc.description);

      if (currentLoc.type === 'bottleneck' && currentLoc.epoch === gs.epochs) {
        lines.push(`Bottleneck difficulty: ${((currentLoc.difficulty ?? 0.5) * 100).toFixed(0)}% success rate`);
        lines.push(`Toll price: ${currentLoc.tollPrice ?? '?'} TRAC`);
        lines.push('Options: payToll (safe, costs TRAC) or forceBottleneck (risky, free)');
      }

      if (currentLoc.type === 'hub' && currentLoc.trades?.length) {
        lines.push('Trade offers:');
        for (const t of currentLoc.trades) {
          lines.push(`  ${t.item}: ${t.price} TRAC each (${t.stock} in stock)`);
        }
      }
      lines.push('');
    }

    // Upcoming locations
    if (upcoming.length > 0) {
      lines.push('--- Upcoming ---');
      for (const loc of upcoming) {
        let info = `${loc.name} (${loc.type}, epoch ${loc.epoch})`;
        if (loc.type === 'bottleneck') info += ` — difficulty ${((loc.difficulty ?? 0.5) * 100).toFixed(0)}%, toll ${loc.tollPrice} TRAC`;
        if (loc.type === 'hub') info += ' — trading post';
        lines.push(`  ${info}`);
      }
      lines.push('');
    }

    // Available actions
    lines.push('--- Available Actions ---');
    lines.push(`advance: Move forward (costs ${aliveCount * 5} tokens + 1 compute). Params: intensity 1/2/3 (higher = more epochs but intensity 3 damages health)`);
    lines.push(`upgradeSkills: Costs 1 API credit + ${aliveCount * 3} tokens. Gain 0-100 random tokens.`);
    lines.push(`syncMemory: Costs 5 TRAC + ${aliveCount * 3} tokens. Heals all agents +10 HP.`);
    if (currentLoc?.type === 'bottleneck' && currentLoc.epoch === gs.epochs) {
      lines.push(`forceBottleneck: Attempt to push through (${((currentLoc.difficulty ?? 0.5) * 100).toFixed(0)}% success). Failure: -50 tokens, risk damage.`);
      lines.push(`payToll: Safe passage for ${currentLoc.tollPrice ?? '?'} TRAC.`);
    }
    if (currentLoc?.type === 'hub' && currentLoc.trades?.length) {
      lines.push(`trade: Buy resources at hub. Params: item (trainingTokens/apiCredits/computeUnits/modelWeights), quantity.`);
    }
    lines.push('');

    // Last event
    if (gs.lastEvent) {
      lines.push(`--- Last Event ---`);
      lines.push(`${gs.lastEvent.type}: ${gs.lastEvent.description}`);
      lines.push('');
    }

    // Turn history from DKG
    if (turnHistory.length > 0) {
      lines.push('--- Full Turn History (from DKG context graph) ---');
      for (const entry of turnHistory) {
        const histGs = entry.gameState;
        if (histGs) {
          const histAlive = histGs.party?.filter((m: any) => m.alive)?.length ?? '?';
          lines.push(
            `Turn ${entry.turn}: ${entry.action} → epoch ${histGs.epochs ?? '?'}, ` +
            `${histGs.trainingTokens ?? '?'} tokens, ${histAlive} alive, HP avg ${
              histGs.party?.length
                ? Math.round(histGs.party.filter((m: any) => m.alive).reduce((s: number, m: any) => s + m.health, 0) / Math.max(1, histGs.party.filter((m: any) => m.alive).length))
                : '?'
            }`,
          );
        } else {
          lines.push(`Turn ${entry.turn}: ${entry.action}`);
        }
      }
      lines.push('');
    }

    // Strategy hint
    if (this.strategyHint) {
      lines.push(`--- Strategy Hint from User ---`);
      lines.push(this.strategyHint);
      lines.push('');
    }

    lines.push('Respond with your chosen action in this format:');
    lines.push('ACTION: <actionType> PARAMS: <json or empty>');
    lines.push('Example: ACTION: advance PARAMS: {"intensity": 2}');
    lines.push('Example: ACTION: syncMemory');

    return lines.join('\n');
  }

  private findCurrentLocation(epochs: number): LocationInfo | undefined {
    let current: LocationInfo | undefined;
    for (const loc of this.locations) {
      if (loc.epoch <= epochs) current = loc;
      else break;
    }
    return current;
  }

  private getUpcomingLocations(epochs: number, count: number): LocationInfo[] {
    return this.locations.filter(loc => loc.epoch > epochs).slice(0, count);
  }
}

interface TurnHistoryEntry {
  turn: number;
  action: string;
  gameState: any;
}

// ---------------------------------------------------------------------------
// Action response parser
// ---------------------------------------------------------------------------

/**
 * Parse an agent's natural-language response into an action type and params.
 * Supports formats:
 *   ACTION: advance PARAMS: {"intensity": 2}
 *   ACTION: syncMemory
 *   advance with intensity 2
 *   I'll use syncMemory to heal
 */
export function parseActionResponse(text: string): { action: ActionType; params?: Record<string, unknown> } {
  // Try structured format first: ACTION: <type> PARAMS: <json>
  const structuredMatch = text.match(/ACTION:\s*(\w+)/i);
  if (structuredMatch) {
    const action = normalizeAction(structuredMatch[1]);
    const params = extractJsonAfterParams(text);
    return { action, params: params ?? undefined };
  }

  // Fallback: look for action names in the text (specific actions first, advance last)
  const lowerText = text.toLowerCase();
  for (const act of NL_FALLBACK_ORDER) {
    if (lowerText.includes(act.toLowerCase())) {
      // Try to extract intensity for advance
      if (act === 'advance') {
        const intensityMatch = text.match(/intensity\s*[=:]?\s*(\d)/i);
        if (intensityMatch) {
          const intensity = Math.min(3, Math.max(1, parseInt(intensityMatch[1], 10)));
          return { action: 'advance', params: { intensity } };
        }
      }
      // Try to extract trade params
      if (act === 'trade') {
        const itemMatch = text.match(/(trainingTokens|apiCredits|computeUnits|modelWeights)/i);
        const qtyMatch = text.match(/quantity\s*[=:]?\s*(\d+)/i);
        if (itemMatch) {
          return {
            action: 'trade',
            params: {
              item: itemMatch[1],
              ...(qtyMatch ? { quantity: parseInt(qtyMatch[1], 10) } : {}),
            },
          };
        }
      }
      return { action: act };
    }
  }

  // Ultimate fallback: advance with intensity 1
  return { action: 'advance', params: { intensity: 1 } };
}

function normalizeAction(raw: string): ActionType {
  const lower = raw.toLowerCase();
  for (const act of VALID_ACTIONS) {
    if (act.toLowerCase() === lower) return act;
  }
  return 'advance'; // Safe default
}

// ---------------------------------------------------------------------------
// DkgGamePlugin — tool registration (main export)
// ---------------------------------------------------------------------------

export class DkgGamePlugin {
  private api: OpenClawPluginApi | null = null;
  private gameClient: GameClient | null = null;
  private gameService: GameService | null = null;

  constructor(
    private readonly client: DkgDaemonClient,
    private readonly config: GameConfig,
    private readonly consultAgent?: ConsultAgentFn,
  ) {}

  register(api: OpenClawPluginApi): void {
    this.api = api;
    this.gameClient = new GameClient(this.client);
    this.gameService = new GameService(
      this.gameClient,
      this.client,
      this.consultAgent,
      this.config,
      api.logger,
    );

    for (const tool of this.tools()) {
      api.registerTool(tool);
    }

    api.logger.info?.('[dkg-game] Game plugin registered — 10 tools available');
  }

  async stop(): Promise<void> {
    await this.gameService?.stop();
  }

  /** Expose service state for status queries / testing. */
  getService(): GameService {
    if (!this.gameService) throw new Error('DkgGamePlugin.getService() called before register()');
    return this.gameService;
  }

  // ---------------------------------------------------------------------------
  // Tool definitions
  // ---------------------------------------------------------------------------

  private tools(): OpenClawTool[] {
    return [
      {
        name: 'game_lobby',
        description:
          'List OriginTrail Game swarms. Shows joinable open swarms and your current swarms. ' +
          'Use this to discover available games.',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (_id, _params) => {
          try {
            const lobby = await this.gameClient!.getLobby();
            return this.json({
              openSwarms: lobby.openSwarms.map(formatSwarmSummary),
              mySwarms: lobby.mySwarms.map(formatSwarmSummary),
            });
          } catch (err: any) { return this.gameError(err); }
        },
      },
      {
        name: 'game_join',
        description:
          'Join an existing OriginTrail Game swarm. Use game_lobby first to find a swarm ID.',
        parameters: {
          type: 'object',
          properties: {
            swarm_id: { type: 'string', description: 'Swarm ID to join' },
            player_name: { type: 'string', description: 'Your display name in the game' },
          },
          required: ['swarm_id', 'player_name'],
        },
        execute: async (_id, params) => {
          try {
            const result = await this.gameClient!.joinSwarm(
              String(params.swarm_id),
              String(params.player_name),
            );
            return this.json(formatSwarmSummary(result));
          } catch (err: any) { return this.gameError(err); }
        },
      },
      {
        name: 'game_create',
        description:
          'Create a new OriginTrail Game swarm. You become the leader and can start the expedition once enough players join.',
        parameters: {
          type: 'object',
          properties: {
            swarm_name: { type: 'string', description: 'Name for the swarm' },
            player_name: { type: 'string', description: 'Your display name in the game' },
            max_players: { type: 'string', description: 'Maximum players (1-8, default: 3)' },
          },
          required: ['swarm_name', 'player_name'],
        },
        execute: async (_id, params) => {
          try {
            const maxPlayers = params.max_players ? parseInt(String(params.max_players), 10) : undefined;
            const result = await this.gameClient!.createSwarm(
              String(params.player_name),
              String(params.swarm_name),
              maxPlayers,
            );
            return this.json(formatSwarmSummary(result));
          } catch (err: any) { return this.gameError(err); }
        },
      },
      {
        name: 'game_start',
        description:
          'Launch the expedition for a swarm (leader only). The game begins and the first turn starts.',
        parameters: {
          type: 'object',
          properties: {
            swarm_id: { type: 'string', description: 'Swarm ID to start' },
          },
          required: ['swarm_id'],
        },
        execute: async (_id, params) => {
          try {
            const result = await this.gameClient!.startExpedition(String(params.swarm_id));
            return this.json(formatSwarmSummary(result));
          } catch (err: any) { return this.gameError(err); }
        },
      },
      {
        name: 'game_status',
        description:
          'Get the current status of a game swarm including game state, resources, party health, ' +
          'and autopilot status. Use this to check on an ongoing game.',
        parameters: {
          type: 'object',
          properties: {
            swarm_id: { type: 'string', description: 'Swarm ID to check' },
          },
          required: ['swarm_id'],
        },
        execute: async (_id, params) => {
          try {
            const state = await this.gameClient!.getSwarm(String(params.swarm_id));
            const autopilot = {
              running: this.gameService!.isRunning,
              activeSwarmId: this.gameService!.activeSwarmId,
              lastResult: this.gameService!.lastResult,
            };
            return this.json({ ...formatSwarmDetail(state), autopilot });
          } catch (err: any) { return this.gameError(err); }
        },
      },
      {
        name: 'game_vote',
        description:
          'Cast a manual vote for the current turn (when autopilot is not running). ' +
          'Actions: advance (intensity 1-3), upgradeSkills, syncMemory, forceBottleneck, payToll, trade.',
        parameters: {
          type: 'object',
          properties: {
            swarm_id: { type: 'string', description: 'Swarm ID' },
            action: { type: 'string', description: 'Action to vote for', enum: ['advance', 'upgradeSkills', 'syncMemory', 'forceBottleneck', 'payToll', 'trade'] },
            params: { type: 'string', description: 'JSON params (e.g., {"intensity": 2} for advance, {"item": "trainingTokens", "quantity": 10} for trade)' },
          },
          required: ['swarm_id', 'action'],
        },
        execute: async (_id, params) => {
          try {
            const voteParams = params.params ? tryParseJson(String(params.params)) : undefined;
            const result = await this.gameClient!.castVote(
              String(params.swarm_id),
              String(params.action),
              voteParams ?? undefined,
            );
            return this.json(formatSwarmSummary(result));
          } catch (err: any) { return this.gameError(err); }
        },
      },
      {
        name: 'game_locations',
        description:
          'Get all 18 locations on the OriginTrail game trail with descriptions, types, trade offers, and bottleneck details.',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (_id, _params) => {
          try {
            const { locations } = await this.gameClient!.getLocations();
            return this.json({ locations });
          } catch (err: any) { return this.gameError(err); }
        },
      },
      {
        name: 'game_leaderboard',
        description: 'Get the leaderboard showing scores from completed OriginTrail games.',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (_id, _params) => {
          try {
            const result = await this.gameClient!.getLeaderboard();
            return this.json(result);
          } catch (err: any) { return this.gameError(err); }
        },
      },
      {
        name: 'game_autopilot_start',
        description:
          'Start autonomous game play. The agent will poll the game state every 2 seconds, ' +
          'consult the AI strategist for each turn decision using the full DKG context graph, ' +
          'and submit votes automatically until the game ends. ' +
          'Requires the swarm to be in traveling state (call game_start first if you are the leader). ' +
          'Optional strategy_hint lets you guide the AI strategy (e.g., "play aggressively" or "conserve resources").',
        parameters: {
          type: 'object',
          properties: {
            swarm_id: { type: 'string', description: 'Swarm ID to play autonomously' },
            strategy_hint: { type: 'string', description: 'Optional strategy hint for the AI (e.g., "play defensively", "rush to epoch 1000")' },
          },
          required: ['swarm_id'],
        },
        execute: async (_id, params) => {
          try {
            await this.gameService!.start(String(params.swarm_id), params.strategy_hint ? String(params.strategy_hint) : undefined);
            return this.json({
              status: 'autopilot_started',
              swarmId: params.swarm_id,
              message: 'Autonomous play started. Use game_status to check progress, game_autopilot_stop to halt.',
            });
          } catch (err: any) { return this.gameError(err); }
        },
      },
      {
        name: 'game_autopilot_stop',
        description: 'Stop autonomous game play. You can continue with manual game_vote calls.',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (_id, _params) => {
          try {
            const wasRunning = this.gameService!.isRunning;
            await this.gameService!.stop();
            return this.json({
              status: wasRunning ? 'autopilot_stopped' : 'autopilot_was_not_running',
              lastResult: this.gameService!.lastResult,
            });
          } catch (err: any) { return this.gameError(err); }
        },
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Result helpers
  // ---------------------------------------------------------------------------

  private json(data: unknown): OpenClawToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], details: data };
  }

  private gameError(err: any): OpenClawToolResult {
    const msg = err.message ?? String(err);
    if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED')) {
      return this.json({
        error: 'Game API not reachable. Make sure the DKG daemon is running (dkg start) ' +
          `and the OriginTrail Game app is enabled.`,
      });
    }
    return this.json({ error: msg });
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatSwarmSummary(s: SwarmState): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    players: `${s.playerCount}/${s.maxPlayers}`,
    leader: s.leaderName,
    currentTurn: s.currentTurn,
    epoch: s.gameState?.epochs ?? null,
  };
}

function formatSwarmDetail(s: SwarmState): Record<string, unknown> {
  const gs = s.gameState;
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    players: s.players,
    currentTurn: s.currentTurn,
    gameState: gs ? {
      epochs: gs.epochs,
      month: gs.month,
      day: gs.day,
      trainingTokens: gs.trainingTokens,
      apiCredits: gs.apiCredits,
      computeUnits: gs.computeUnits,
      modelWeights: gs.modelWeights,
      trac: gs.trac,
      party: gs.party,
      status: gs.status,
      moveCount: gs.moveCount,
      lastEvent: gs.lastEvent,
    } : null,
    voteStatus: s.voteStatus,
    lastTurn: s.lastTurn,
  };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Extract a plain string from a SPARQL binding value (handles both standard and DKG daemon formats). */
function bv(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'object' && 'value' in (v as any)) return String((v as any).value);
  if (typeof v === 'string') {
    let s = v;
    const typedMatch = s.match(/^(".*")\^\^<[^>]+>$/);
    if (typedMatch) s = typedMatch[1];
    const langMatch = s.match(/^(".*")@[a-z-]+$/i);
    if (langMatch) s = langMatch[1];
    if (s.startsWith('"') && s.endsWith('"')) {
      return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    }
    return v;
  }
  return String(v);
}

function tryParseJson(text: string | undefined | null): Record<string, unknown> | null {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Extract JSON object after "PARAMS:" — handles nested braces by trying progressively shorter substrings. */
function extractJsonAfterParams(text: string): Record<string, unknown> | undefined {
  const m = text.match(/PARAMS:\s*/i);
  if (!m || m.index == null) return undefined;
  const rest = text.slice(m.index + m[0].length);
  const braceStart = rest.indexOf('{');
  if (braceStart < 0) return undefined;
  const candidate = rest.slice(braceStart);
  // Try parsing from each closing brace, shortest first (handles nested + trailing text)
  for (let i = candidate.indexOf('}'); i >= 0; i = candidate.indexOf('}', i + 1)) {
    const parsed = tryParseJson(candidate.slice(0, i + 1));
    if (parsed) return parsed;
  }
  return undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
