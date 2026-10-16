import type { BoundPromoteRequest } from './async-promote-queue-types.js';
import { validatePromoteRecoveryBinding } from './promote-recovery-binding.js';

/** One runtime boundary for internal admission and persisted format-4 records. */
export function isBoundPromoteRequest(value: unknown): value is BoundPromoteRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Record<string, unknown>;
  if (typeof request.contextGraphId !== 'string' || !request.contextGraphId
    || typeof request.assertionName !== 'string' || !request.assertionName
    || request.entities !== 'all' || typeof request.agentAddress !== 'string' || !request.agentAddress.trim()
    || (request.subGraphName !== undefined && typeof request.subGraphName !== 'string')
    || (request.authorAgentAddress !== undefined && typeof request.authorAgentAddress !== 'string')) return false;
  try { validatePromoteRecoveryBinding(request.recoveryBinding); return true; } catch { return false; }
}
