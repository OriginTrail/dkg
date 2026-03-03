import type { SessionManager } from '../session-manager.js';
import type { SessionConfig, SessionMember, QuorumPolicy, ReducerConfig } from '../types.js';

export interface SessionRouteHandler {
  method: 'GET' | 'POST';
  path: string;
  handler: (req: RouteRequest) => Promise<RouteResponse>;
}

export interface RouteRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface RouteResponse {
  status: number;
  body: unknown;
}

interface CreateSessionBody {
  paranetId: string;
  appId: string;
  membership: Array<{
    peerId: string;
    pubKey: string;
    displayName: string;
    role: 'creator' | 'member';
  }>;
  quorumPolicy: QuorumPolicy;
  reducer: ReducerConfig;
  roundTimeout: number;
  maxRounds: number | null;
}

interface SubmitInputBody {
  data: string;
}

export function createSessionRoutes(manager: SessionManager): SessionRouteHandler[] {
  return [
    {
      method: 'POST',
      path: '/api/sessions',
      handler: async (req) => {
        try {
          const body = req.body as CreateSessionBody;
          const membership: SessionMember[] = body.membership.map((m) => ({
            peerId: m.peerId,
            pubKey: hexToBytes(m.pubKey),
            displayName: m.displayName,
            role: m.role,
          }));

          const config = await manager.createSession(
            body.paranetId,
            body.appId,
            membership,
            body.quorumPolicy,
            body.reducer,
            body.roundTimeout,
            body.maxRounds,
          );

          return {
            status: 201,
            body: serializeConfig(config),
          };
        } catch (err) {
          return { status: 400, body: { error: errorMessage(err) } };
        }
      },
    },

    {
      method: 'GET',
      path: '/api/sessions',
      handler: async (req) => {
        const sessions = manager.listSessions(req.query.paranetId, req.query.status);
        return {
          status: 200,
          body: sessions.map(serializeConfig),
        };
      },
    },

    {
      method: 'GET',
      path: '/api/sessions/:id',
      handler: async (req) => {
        const session = manager.getSession(req.params.id);
        if (!session) return { status: 404, body: { error: 'session not found' } };
        return {
          status: 200,
          body: {
            ...serializeConfig(session.config),
            currentRound: session.currentRound,
            latestFinalizedRound: session.latestFinalizedRound,
            latestStateHash: session.latestStateHash,
            equivocators: [...session.equivocators],
          },
        };
      },
    },

    {
      method: 'POST',
      path: '/api/sessions/:id/accept',
      handler: async (req) => {
        try {
          await manager.acceptSession(req.params.id);
          return { status: 200, body: { accepted: true } };
        } catch (err) {
          return { status: 400, body: { error: errorMessage(err) } };
        }
      },
    },

    {
      method: 'POST',
      path: '/api/sessions/:id/activate',
      handler: async (req) => {
        try {
          await manager.activateSession(req.params.id);
          return { status: 200, body: { activated: true } };
        } catch (err) {
          return { status: 400, body: { error: errorMessage(err) } };
        }
      },
    },

    {
      method: 'POST',
      path: '/api/sessions/:id/rounds/:n/start',
      handler: async (req) => {
        try {
          await manager.startRound(req.params.id);
          return { status: 200, body: { started: true, round: Number(req.params.n) } };
        } catch (err) {
          return { status: 400, body: { error: errorMessage(err) } };
        }
      },
    },

    {
      method: 'POST',
      path: '/api/sessions/:id/rounds/:n/input',
      handler: async (req) => {
        try {
          const body = req.body as SubmitInputBody;
          const data = hexToBytes(body.data);
          await manager.submitInput(req.params.id, data);
          return { status: 200, body: { submitted: true } };
        } catch (err) {
          return { status: 400, body: { error: errorMessage(err) } };
        }
      },
    },

    {
      method: 'GET',
      path: '/api/sessions/:id/rounds/:n',
      handler: async (req) => {
        const session = manager.getSession(req.params.id);
        if (!session) return { status: 404, body: { error: 'session not found' } };

        const round = Number(req.params.n);
        const roundState = session.roundStates.get(round);
        if (!roundState) return { status: 404, body: { error: 'round not found' } };

        return {
          status: 200,
          body: {
            round: roundState.round,
            status: roundState.status,
            proposerPeerId: roundState.proposerPeerId,
            inputCount: roundState.inputs.size,
            ackCount: roundState.acks.size,
            hasProposal: roundState.proposal !== null,
            proposalNextStateHash: roundState.proposal?.nextStateHash ?? null,
          },
        };
      },
    },

    {
      method: 'GET',
      path: '/api/sessions/:id/rounds/:n/acks',
      handler: async (req) => {
        const session = manager.getSession(req.params.id);
        if (!session) return { status: 404, body: { error: 'session not found' } };

        const round = Number(req.params.n);
        const roundState = session.roundStates.get(round);
        if (!roundState) return { status: 404, body: { error: 'round not found' } };

        const acks = [...roundState.acks.entries()].map(([peerId, ack]) => ({
          peerId,
          nextStateHash: ack.nextStateHash,
          turnCommitment: ack.turnCommitment,
        }));

        return { status: 200, body: { round, acks } };
      },
    },

    {
      method: 'GET',
      path: '/api/sessions/:id/state',
      handler: async (req) => {
        const session = manager.getSession(req.params.id);
        if (!session) return { status: 404, body: { error: 'session not found' } };

        return {
          status: 200,
          body: {
            sessionId: session.config.sessionId,
            status: session.config.status,
            latestFinalizedRound: session.latestFinalizedRound,
            latestStateHash: session.latestStateHash,
          },
        };
      },
    },
  ];
}

function serializeConfig(config: SessionConfig): Record<string, unknown> {
  const { membership, ...rest } = config;
  return {
    ...rest,
    membership: membership.map((m) => ({
      peerId: m.peerId,
      pubKey: bytesToHex(m.pubKey),
      displayName: m.displayName,
      role: m.role,
    })),
  };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
