// SPDX-License-Identifier: Apache-2.0

import { resolveAuthorityIndexConfig } from '../src/index.js';

declare const rawConfig: unknown;

resolveAuthorityIndexConfig(rawConfig, 'edge');
resolveAuthorityIndexConfig(rawConfig, 'core');
// @ts-expect-error The caller must supply a role so core nodes cannot silently default to edge.
resolveAuthorityIndexConfig(rawConfig);
