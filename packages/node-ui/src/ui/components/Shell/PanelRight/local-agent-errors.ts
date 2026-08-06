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
    if (err.code === 'PRIME_AGENT_SESSION_BUSY') {
      return `${integration.name} session is busy — try again in a moment.`;
    }
    // The PRIME_AGENT_* terminal codes below must stay in lock-step with
    // PrimeAgentTurnErrorCode in
    // packages/adapter-prime-agent/extension/src/extension.ts and
    // SANITIZED_PRIME_AGENT_BRIDGE_FAILURES in
    // packages/cli/src/daemon/routes/prime-agent.ts; an unmatched code falls
    // through to the raw daemon message at the bottom of this function.
    if (err.code === 'PRIME_AGENT_PROVIDER_UNAUTHORIZED') {
      return `${integration.name} provider authentication failed. Check its provider credentials and try again.`;
    }
    if (err.code === 'PRIME_AGENT_PROVIDER_ERROR') {
      return `${integration.name} provider request failed. Check its provider configuration and try again.`;
    }
    if (err.code === 'PRIME_AGENT_TURN_ABORTED') {
      return `${integration.name} turn was aborted.`;
    }
    if (err.code === 'PRIME_AGENT_TURN_TIMEOUT') {
      return `${integration.name} turn exceeded its maximum run time.`;
    }
    if (err.code === 'PRIME_AGENT_DELIVERY_FAILED') {
      return `${integration.name} rejected the message before starting the turn.`;
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
