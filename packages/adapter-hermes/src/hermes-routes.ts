import type {
  DaemonPluginApi,
  HermesChannelPersistTurnPayload,
} from './types.js';

export function registerHermesRoutes(api: DaemonPluginApi): void {
  api.registerHttpRoute({
    method: 'POST',
    path: '/api/hermes-channel/persist-turn',
    handler: async (req, res) => {
      await handlePersistTurn(api, req.body as Partial<HermesChannelPersistTurnPayload>, res);
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
