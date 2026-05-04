import type { JsonLdContent, JsonLdDocument } from '@origintrail-official/dkg-agent';

/**
 * Wrap a JSON-LD document in the `{ public }` or `{ private }` envelope
 * shape that DKGAgent.publish() expects.
 *
 * The envelope choice is the privacy boundary: `{ private: ... }` is
 * encrypted to context-graph participants per V10's private-KA flow;
 * `{ public: ... }` is cleartext. See packages/agent/src/dkg-agent.ts
 * publish() overloads for the contract.
 */
export function wrapJsonLdContent(
  content: JsonLdDocument,
  options: { private: boolean },
): JsonLdContent {
  return options.private ? { private: content } : { public: content };
}
