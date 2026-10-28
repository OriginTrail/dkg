import type { AgentIdentity } from './api.js';
import { getBoundedJson } from './http.js';

/** Bound headers and body so shared identity refresh cannot pin inventory ownership. */
export const fetchCurrentAgent = (): Promise<AgentIdentity> => getBoundedJson('/api/agent/identity');
