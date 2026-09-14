import { resolveCatchupResourceEnvironment } from '../resource-limits.js';

/** Catch-up-owned process snapshot. Importing this module cannot initialize VM policy. */
export const CATCHUP_RESOURCE_ENV = resolveCatchupResourceEnvironment(process.env);
