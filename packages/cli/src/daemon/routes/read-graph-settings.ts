import { isReadGraphEligibleContextGraphId } from '@origintrail-official/dkg-core';
import {
  READ_GRAPH_SETTINGS_ACTOR_HEADER,
  READ_GRAPH_SETTINGS_PATH,
  parseReadGraphSettingsRequest,
  readGraphSettingsActorOf,
} from '../../read-graph-settings-wire.js';
import { jsonResponse, readBody, SMALL_BODY_BYTES } from '../http-utils.js';
import { requireNodeAdmin } from '../node-admin-guard.js';
import { actorFromRequestContext, type RequestContext } from './context.js';

/**
 * Node-admin settings of search across assets (read graphs) per context graph:
 *
 * - `GET /api/store/read-graphs/settings[?contextGraphId=]`: config.json's policy, the node's own modes, the settings
 *   of each context graph that has its own or read graphs (or of the one asked for), what is in force for each, and
 *   their read graphs;
 * - `PUT /api/store/read-graphs/settings` `{ contextGraphId, layers?, viewSemantics? }`: change one context graph's
 *   own settings and apply them to the running node (`ReadGraphSettingsControl`).
 *
 * Who asks goes into the settings table: the `X-DKG-Actor` header names `cli`, `ui` or `agent:<id>`, and `api` stands
 * for any other caller.
 */
export async function handleReadGraphSettingsRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path } = ctx;
  if (path !== READ_GRAPH_SETTINGS_PATH || (req.method !== 'GET' && req.method !== 'PUT')) return;
  const action = req.method === 'GET' ? 'read the node\'s search-across-assets settings' : 'change the node\'s search-across-assets settings';
  if (!requireNodeAdmin(actorFromRequestContext(ctx).authentication, res, `${req.method} ${path}`, action)) return;
  const control = ctx.readGraphSettings;
  if (control === undefined) {
    return jsonResponse(res, 503, { code: 'READ_GRAPH_SETTINGS_UNAVAILABLE', error: 'This node\'s search-across-assets settings aren\'t available yet; try again once it has started.' });
  }
  if (req.method === 'GET') {
    const contextGraphId = ctx.url.searchParams.get('contextGraphId') ?? undefined;
    if (contextGraphId !== undefined && !isReadGraphEligibleContextGraphId(contextGraphId)) {
      return jsonResponse(res, 400, { code: 'READ_GRAPH_SETTINGS_INVALID', error: 'contextGraphId must be the ID of a context graph that can search across assets.' });
    }
    return jsonResponse(res, 200, await control.answer(contextGraphId));
  }
  const parsed = parseReadGraphSettingsRequest(jsonOf(await readBody(req, SMALL_BODY_BYTES)));
  if ('error' in parsed) return jsonResponse(res, 400, { code: 'READ_GRAPH_SETTINGS_INVALID', error: parsed.error });
  const header = req.headers[READ_GRAPH_SETTINGS_ACTOR_HEADER];
  const actor = readGraphSettingsActorOf(header);
  if (header !== undefined && actor === undefined) {
    return jsonResponse(res, 400, { code: 'READ_GRAPH_SETTINGS_INVALID', error: 'X-DKG-Actor must be cli, ui or agent:<id>.' });
  }
  const gone = new AbortController();
  res.once('close', () => gone.abort());
  const outcome = await control.change(parsed.request, actor ?? 'api', gone.signal);
  return jsonResponse(res, outcome.status, outcome.body);
}

/** A body that is no JSON at all becomes `undefined`, which the parser refuses as it refuses any non-object. */
function jsonOf(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
