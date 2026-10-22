import type { KnowledgeAssetPublishAuthorSelection } from './api-client.js';
import { finalizedPublishOptionsPayload, type KnowledgeAssetFinalizedPublishOptions } from './finalized-publish-options.js';

/** The request body shared by `vm/publish` and `vm/publish-async`. */
export function vmPublishRequestBody(
  contextGraphId: string,
  options?: KnowledgeAssetPublishAuthorSelection & KnowledgeAssetFinalizedPublishOptions,
): Record<string, unknown> {
  // GH#1786 — `selectedAuthorAgentAddress` is destructured out alongside
  // `subGraphName` for two reasons: the daemon reads it at the TOP level of the
  // body, and `finalizedPublishOptionsPayload` throws on any key outside its
  // allowlist, so leaving it in would break every publish that supplies it.
  const { subGraphName, selectedAuthorAgentAddress, ...finalizedOptions } = options ?? {};
  const publishOptions = finalizedPublishOptionsPayload(finalizedOptions);
  return {
    contextGraphId,
    ...(subGraphName ? { subGraphName } : {}),
    // Presence, NOT truthiness: an explicitly empty/malformed selector must reach
    // the daemon so it is rejected 400, rather than being silently omitted here and
    // letting normal author resolution publish a different author.
    ...(selectedAuthorAgentAddress !== undefined ? { selectedAuthorAgentAddress } : {}),
    ...(publishOptions ? { options: publishOptions } : {}),
  };
}
