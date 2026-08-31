// SPDX-License-Identifier: Apache-2.0

import type {
  StrictChangelogWorkSelector,
} from '../src/sync/requester/transport-plan.js';

const validStrictSelector: StrictChangelogWorkSelector<string> = (contextGraphId) => (
  contextGraphId === 'public'
    ? { lane: 'changelog', run: async () => contextGraphId }
    : { lane: 'deferred' }
);

void validStrictSelector;

// A strict changelog caller has no durable branch or durable callback to fake.
const invalidStrictSelector: StrictChangelogWorkSelector<string> = () => ({
  // @ts-expect-error durable work is excluded from StrictChangelogWorkSelector
  lane: 'durable',
  run: async () => 'invalid',
});

void invalidStrictSelector;
