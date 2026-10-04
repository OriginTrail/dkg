// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphMetaRecord } from './context-graph-meta-projection.js';

function delegationIsCurrentlyActive(expiresAtValues: readonly string[], nowMs: number): boolean {
  if (expiresAtValues.length === 0) return true;
  return expiresAtValues.some((value) => {
    const expiresAt = Number(value);
    return !Number.isFinite(expiresAt) || expiresAt <= 0 || expiresAt >= nowMs;
  });
}

export function collectProjectedDelegatees(
  meta: ContextGraphMetaRecord,
  field: 'allowedPeers' | 'allowedKeys',
  normalizeValue: (value: string) => string,
): Map<string, string[]> {
  const members = new Set(
    [...meta.allowedAgents, ...meta.participantAgents].map((agent) => agent.toLowerCase()),
  );
  const revoked = new Set(meta.revokedAgents.map((agent) => agent.toLowerCase()));
  const out = new Map<string, string[]>();
  const nowMs = Date.now();

  for (const delegation of meta.delegations) {
    if (!delegationIsCurrentlyActive(delegation.expiresAtValues, nowMs)) continue;
    for (const rawAgent of delegation.agents) {
      const agent = rawAgent.toLowerCase();
      if (!agent || !members.has(agent) || revoked.has(agent)) continue;
      const values = out.get(agent) ?? [];
      for (const rawValue of delegation[field]) {
        const value = normalizeValue(rawValue);
        if (value && !values.includes(value)) values.push(value);
      }
      if (values.length > 0) out.set(agent, values);
    }
  }
  return out;
}
