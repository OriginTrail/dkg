import type {
  DaemonPluginApi,
  HermesChannelPersistTurnPayload,
  HermesChannelSendPayload,
  SessionEndPayload,
  SessionTurnPayload,
} from './types.js';

export function registerHermesRoutes(api: DaemonPluginApi): void {
  api.registerHttpRoute({
    method: 'GET',
    path: '/api/hermes-channel/health',
    handler: async (_req, res) => {
      res.status(503).json({
        ok: false,
        status: 'degraded',
        error: 'Hermes bridge dispatcher is not registered in this adapter package yet.',
        bridge: { ready: false },
      });
    },
  });

  api.registerHttpRoute({
    method: 'POST',
    path: '/api/hermes-channel/send',
    handler: async (req, res) => {
      const body = req.body as Partial<HermesChannelSendPayload>;
      if (!body.text || !body.correlationId) {
        res.status(400).json({ success: false, error: 'text and correlationId required' });
        return;
      }
      res.status(501).json({
        success: false,
        error: 'Hermes bridge send is a daemon/client contract route; no bridge dispatcher is registered in this package yet.',
      });
    },
  });

  api.registerHttpRoute({
    method: 'POST',
    path: '/api/hermes-channel/stream',
    handler: async (req, res) => {
      const body = req.body as Partial<HermesChannelSendPayload>;
      if (!body.text || !body.correlationId) {
        res.status(400).json({ success: false, error: 'text and correlationId required' });
        return;
      }
      res.status(501).json({
        success: false,
        error: 'Hermes bridge stream is a daemon/client contract route; no bridge dispatcher is registered in this package yet.',
      });
    },
  });

  api.registerHttpRoute({
    method: 'POST',
    path: '/api/hermes-channel/persist-turn',
    handler: async (req, res) => {
      await handlePersistTurn(api, req.body as Partial<HermesChannelPersistTurnPayload>, res);
    },
  });

  api.registerHttpRoute({
    method: 'POST',
    path: '/api/hermes/session-turn',
    handler: async (req, res) => {
      const body = req.body as SessionTurnPayload & { agentName?: string };
      await handlePersistTurn(api, {
        sessionId: body.sessionId,
        turnId: body.turnId ?? `${body.sessionId}:legacy`,
        idempotencyKey: body.idempotencyKey ?? `${body.sessionId}:legacy`,
        userMessage: body.user ?? '',
        assistantReply: body.assistant ?? '',
        source: 'hermes-provider',
      }, res);
    },
  });

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
        api.logger.info?.(`[hermes] Session ended: ${body.sessionId} (${body.turnCount ?? 0} turns)`);
        res.json({ success: true, sessionId: body.sessionId });
      } catch (err) {
        api.logger.warn?.(`[hermes] session-end error: ${err}`);
        res.status(500).json({ success: false, error: String(err) });
      }
    },
  });

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

async function handlePersistTurn(
  api: DaemonPluginApi,
  body: Partial<HermesChannelPersistTurnPayload>,
  res: any,
): Promise<void> {
  try {
    if (!body.sessionId || !body.turnId || !body.idempotencyKey) {
      res.status(400).json({ success: false, error: 'sessionId, turnId, and idempotencyKey required' });
      return;
    }
    if (!body.userMessage && !body.assistantReply) {
      res.status(400).json({ success: false, error: 'at least one of userMessage/assistantReply required' });
      return;
    }

    if (api.agent.storeChatTurn) {
      await api.agent.storeChatTurn(
        body.sessionId,
        body.userMessage ?? '',
        body.assistantReply ?? '',
        {
          turnId: body.turnId,
          idempotencyKey: body.idempotencyKey,
          source: body.source ?? 'hermes-channel',
        },
      );
    }

    if (api.agent.importMemories && body.assistantReply) {
      try {
        await api.agent.importMemories(
          body.assistantReply,
          `hermes-session:${body.sessionId}:turn:${body.turnId}`,
        );
      } catch (extractErr) {
        api.logger.debug?.(`[hermes] Entity extraction failed: ${extractErr}`);
      }
    }

    res.json({ success: true, sessionId: body.sessionId, turnId: body.turnId });
  } catch (err) {
    api.logger.warn?.(`[hermes] persist-turn error: ${err}`);
    res.status(500).json({ success: false, error: String(err) });
  }
}
