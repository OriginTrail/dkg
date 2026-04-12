/**
 * HTTP routes for the Hermes adapter.
 *
 * Registered on the daemon at /api/hermes/* — these are the endpoints
 * the Python DKGMemoryProvider calls via its HTTP client.
 */

import type { DaemonPluginApi, SessionTurnPayload, SessionEndPayload } from './types.js';

/**
 * Register Hermes-specific HTTP routes on the daemon.
 */
export function registerHermesRoutes(api: DaemonPluginApi): void {

  // ── POST /api/hermes/session-turn ──────────────────────────────────────
  // Receives a chat turn from the Hermes agent. Persists it and triggers
  // entity extraction via the daemon's importMemories pipeline.
  api.registerHttpRoute({
    method: 'POST',
    path: '/api/hermes/session-turn',
    handler: async (req, res) => {
      try {
        const body = req.body as SessionTurnPayload & { agentName?: string };

        if (!body.sessionId || (!body.user && !body.assistant)) {
          res.status(400).json({ success: false, error: 'sessionId and at least one of user/assistant required' });
          return;
        }

        const agentTag = body.agentName ? `${body.agentName}:` : '';

        // Store the chat turn for session history
        if (api.agent.storeChatTurn) {
          await api.agent.storeChatTurn(body.sessionId, body.user ?? '', body.assistant ?? '');
        }

        // Extract entities from the assistant's response using the daemon's
        // LLM pipeline. agentName is included in the source tag so entities
        // are scoped to the correct agent's assertion in the triple store.
        if (api.agent.importMemories && body.assistant) {
          try {
            await api.agent.importMemories(
              body.assistant,
              `${agentTag}hermes-session:${body.sessionId}`,
            );
          } catch (extractErr) {
            // Non-fatal: entity extraction failure shouldn't break turn persistence
            api.logger.debug?.(`[hermes] Entity extraction failed: ${extractErr}`);
          }
        }

        res.json({ success: true, sessionId: body.sessionId });
      } catch (err) {
        api.logger.warn?.(`[hermes] session-turn error: ${err}`);
        res.status(500).json({ success: false, error: String(err) });
      }
    },
  });

  // ── POST /api/hermes/session-end ───────────────────────────────────────
  // Called when the Hermes agent session ends. Finalizes session metadata.
  api.registerHttpRoute({
    method: 'POST',
    path: '/api/hermes/session-end',
    handler: async (req, res) => {
      try {
        const body: SessionEndPayload = req.body;

        if (!body.sessionId) {
          res.status(400).json({ success: false, error: 'sessionId required' });
          return;
        }

        api.logger.info?.(
          `[hermes] Session ended: ${body.sessionId} (${body.turnCount ?? 0} turns)`,
        );

        res.json({ success: true, sessionId: body.sessionId });
      } catch (err) {
        api.logger.warn?.(`[hermes] session-end error: ${err}`);
        res.status(500).json({ success: false, error: String(err) });
      }
    },
  });

  // ── GET /api/hermes/status ─────────────────────────────────────────────
  // Adapter-specific status — shows the Hermes adapter is connected.
  api.registerHttpRoute({
    method: 'GET',
    path: '/api/hermes/status',
    handler: async (_req, res) => {
      res.json({
        adapter: 'hermes',
        framework: 'hermes-agent',
        status: 'connected',
        version: '0.0.1',
      });
    },
  });
}
