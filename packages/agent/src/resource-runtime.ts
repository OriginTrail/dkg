import { resolveAgentResourceEnvironment } from './resource-limits.js';

/** Process-scoped runtime snapshot. Pure parsers never import this module. */
export const AGENT_RESOURCE_ENV = resolveAgentResourceEnvironment(process.env);
