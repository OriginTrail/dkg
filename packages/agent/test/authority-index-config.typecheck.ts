// SPDX-License-Identifier: Apache-2.0

import {
  resolveAuthorityIndexConfig,
  resolveDefaultAuthorityIndexConfig,
  type AuthorityIndexConfig,
  type ResolvedAuthorityIndexConfig,
} from '../src/index.js';

declare const rawConfig: unknown;

resolveAuthorityIndexConfig(rawConfig, 'edge');
resolveAuthorityIndexConfig(rawConfig, 'core');
// @ts-expect-error The caller must supply a role so core nodes cannot silently default to edge.
resolveAuthorityIndexConfig(rawConfig);

const defaults: ResolvedAuthorityIndexConfig | undefined = resolveDefaultAuthorityIndexConfig('edge');
const discovery: 'on-chain-cores' | undefined = defaults?.discovery;
// @ts-expect-error The role default is a role decision too.
resolveDefaultAuthorityIndexConfig();
// @ts-expect-error Discovery is a resolver decision, never persisted configuration.
const explicit: AuthorityIndexConfig = { mode: 'core-snapshot', trustedCorePeers: [], discovery: 'on-chain-cores' };
void discovery;
void explicit;
