import { LocalAgentApiError, type LocalAgentIntegration } from '../../../api.js';

export function formatLocalAgentErrorMessage(
  integration: LocalAgentIntegration,
  err: unknown,
): string {
  const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  if (err instanceof LocalAgentApiError) {
    if (err.code === 'HERMES_BRIDGE_RESPONSE_TIMEOUT') {
      return `${integration.name} bridge response timed out.`;
    }
    if (err.code === 'HERMES_GATEWAY_RESPONSE_TIMEOUT') {
      return `${integration.name} gateway response timed out.`;
    }
    if (err.code === 'OPENCLAW_BRIDGE_RESPONSE_TIMEOUT') {
      return `${integration.name} bridge response timed out.`;
    }
    if (err.code === 'OPENCLAW_GATEWAY_RESPONSE_TIMEOUT') {
      return `${integration.name} gateway response timed out.`;
    }
    if (err.code === 'SWM_SYNC_TIMEOUT' || err.source === 'background-sync') {
      return 'Background sync timed out. The chat request was not marked as failed by the local-agent bridge.';
    }
  }
  if (/OpenClaw bridge unreachable/i.test(message)) {
    return `${integration.name} is unavailable right now.`;
  }
  if (/Hermes bridge unreachable/i.test(message)) {
    return `${integration.name} is unavailable right now.`;
  }
  if (/gateway response timeout/i.test(message)) {
    return `${integration.name} gateway response timed out.`;
  }
  if (/bridge response timeout/i.test(message) || /aborted due to timeout/i.test(message)) {
    return `${integration.name} bridge response timed out.`;
  }
  if (/Agent response timeout/i.test(message)) {
    return `${integration.name} took too long to respond.`;
  }
  if (/Agent returned no text response/i.test(message) || /\(no response\)/i.test(message)) {
    return `${integration.name} did not return a text reply.`;
  }
  return message;
}

