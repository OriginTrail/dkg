// SPDX-License-Identifier: Apache-2.0
import type { GetView } from '@origintrail-official/dkg-core';
import type { ReadGraphMode } from '@origintrail-official/dkg-storage';
import {
  READ_GRAPH_SETTINGS_ACTOR_HEADER,
  READ_GRAPH_SETTINGS_PATH,
  type ReadGraphSettingsAnswer,
  type ReadGraphSettingsRequest,
} from './read-graph-settings-wire.js';

export type { ReadGraphCreateOutcome } from './daemon/read-graph-settings-control.js';

/** The CLI as the settings table's `updated_by`, on a settings change and on a creation that sets read graphs. */
export const CLI_ACTOR_HEADERS: Readonly<Record<string, string>> = Object.freeze({ [READ_GRAPH_SETTINGS_ACTOR_HEADER]: 'cli' });

/** `readGraphs` in the body of a context graph's creation: a mode per memory, applied once it exists. */
export interface ReadGraphsCreateSetting {
  readonly layers: Readonly<Partial<Record<GetView, ReadGraphMode>>>;
}

/** The daemon's read-graph settings route, for `ApiClient.readGraphSettings`; node-admin token only. */
export function createReadGraphSettingsClient(
  get: <T>(path: string) => Promise<T>,
  put: <T>(path: string, body: unknown, headers: Readonly<Record<string, string>>) => Promise<T>,
) {
  return {
    /** The settings and read graphs of every context graph that has either, or of the one named. */
    get(contextGraphId?: string): Promise<ReadGraphSettingsAnswer> {
      const query = contextGraphId === undefined ? '' : `?${new URLSearchParams({ contextGraphId }).toString()}`;
      return get<ReadGraphSettingsAnswer>(`${READ_GRAPH_SETTINGS_PATH}${query}`);
    },
    /** Change one context graph's settings; the answer holds them after the change, with what changed. */
    set(request: ReadGraphSettingsRequest): Promise<ReadGraphSettingsAnswer> {
      return put<ReadGraphSettingsAnswer>(READ_GRAPH_SETTINGS_PATH, request, CLI_ACTOR_HEADERS);
    },
  };
}
