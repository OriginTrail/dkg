import type { SessionBridge } from '../extension/src/extension.js';

type Host = ConstructorParameters<typeof SessionBridge>[0];
export type PreparedBridgeRun = NonNullable<ReturnType<SessionBridge['onBeforeAgentStart']>>;
type Context = Parameters<SessionBridge['onAgentStart']>[0];

/** Simulate Prime's input hook before recording the prepared user submission. */
export function createBridgeHost(getBridge: () => SessionBridge, onSend: Host['sendUserMessage']): Host {
  return {
    on: () => {},
    sendUserMessage(content, options) {
      // Preserve the opaque tag until the real bridge strips it at message_start.
      const result = getBridge().onInput({ source: 'extension', text: content });
      if (result.action === 'handled') return;
      onSend(result.action === 'transform' ? result.text : content, options);
    },
  };
}

/** Commit the exact prepared action, including Prime's cached ownership marker. */
export function commitBridgeRun(bridge: SessionBridge, options: {
  prompt: string | undefined;
  context?: Context;
  prepared?: PreparedBridgeRun;
  userContent?: 'blocks' | 'string';
}): PreparedBridgeRun {
  const { prompt, context, prepared, userContent = 'blocks' } = options;
  if (!prompt) throw new Error('No injected bridge prompt');
  const ownership = prepared ?? bridge.onBeforeAgentStart({ prompt });
  if (!ownership) throw new Error('Bridge prompt did not receive an ownership marker');
  bridge.onAgentStart(context);
  bridge.onMessageStart({ message: { role: 'user',
    content: userContent === 'string' ? prompt : [{ type: 'text', text: prompt }] } });
  bridge.onMessageStart({ message: { role: 'custom', ...ownership.message } });
  return ownership;
}
