// SPDX-License-Identifier: Apache-2.0

/**
 * Public production boundaries used by the repository-level remote
 * certification harness. Keeping this narrow entry point prevents the harness
 * from depending on CLI source layout or a TypeScript loader.
 */
export { createAllowedHttpAuthentication } from '../auth.js';
export { loadBuildInfo } from './manifest.js';
export { handleKnowledgeAssetsRoutes } from './routes/knowledge-assets.js';
export { handleQueryRoutes } from './routes/query.js';
export { handleStatusRoutes } from './routes/status.js';
