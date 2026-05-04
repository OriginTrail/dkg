import type { JsonLdContent, JsonLdDocument } from '@origintrail-official/dkg-agent';

/** Wrap a JSON-LD document in the `{ public }` or `{ private }` envelope `DKGAgent.publish` expects. */
export function wrapJsonLdContent(
  content: JsonLdDocument,
  options: { private: boolean },
): JsonLdContent {
  return options.private ? { private: content } : { public: content };
}
