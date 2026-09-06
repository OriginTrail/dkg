// SPDX-License-Identifier: Apache-2.0

import {
  REGISTERED_CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_REASONS,
} from '../../registered-context-graph-authority.js';

export const CONTEXT_GRAPH_AGENT_GATE_UNAVAILABLE_REASONS = Object.freeze([
  ...REGISTERED_CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_REASONS,
  'rfc64-private-read-roster-unavailable',
] as const);

export type ContextGraphAgentGateUnavailableReason =
  (typeof CONTEXT_GRAPH_AGENT_GATE_UNAVAILABLE_REASONS)[number];

export type ContextGraphAgentGateAuthority =
  | { kind: 'ungated' }
  | { kind: 'available'; agentAddresses: string[] }
  | {
      kind: 'unavailable';
      reason: ContextGraphAgentGateUnavailableReason;
      detail?: string;
    };

export const CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE =
  'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE' as const;

export const CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_ERROR_NAME =
  'ContextGraphAuthorityUnavailableError' as const;

const contextGraphAuthorityUnavailableReasonSet = new Set<string>(
  CONTEXT_GRAPH_AGENT_GATE_UNAVAILABLE_REASONS,
);

/** Serialization-safe authority failure without caller-specific retry policy. */
export type ContextGraphAuthorityUnavailableMarker = {
  readonly code: typeof CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE;
  readonly reason: ContextGraphAgentGateUnavailableReason;
  readonly detail?: string;
};

export class ContextGraphAuthorityUnavailableError extends Error {
  readonly code = CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE;
  readonly reason: ContextGraphAgentGateUnavailableReason;
  readonly detail?: string;

  constructor(
    message: string,
    options: { reason: ContextGraphAgentGateUnavailableReason; detail?: string },
  ) {
    super(message);
    this.name = CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_ERROR_NAME;
    this.reason = options.reason;
    if (options.detail !== undefined) this.detail = options.detail;
  }
}

export function isContextGraphAuthorityUnavailableMarker(
  value: unknown,
): value is ContextGraphAuthorityUnavailableMarker {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }
  try {
    if (Reflect.get(value, 'code') !== CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE) return false;
    const reason = Reflect.get(value, 'reason');
    return typeof reason === 'string'
      && contextGraphAuthorityUnavailableReasonSet.has(reason);
  } catch {
    return false;
  }
}

export function createContextGraphAuthorityError(
  message: string,
  failure: { reason: ContextGraphAgentGateUnavailableReason; detail?: string },
): ContextGraphAuthorityUnavailableError {
  return new ContextGraphAuthorityUnavailableError(message, {
    reason: failure.reason,
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
  });
}
