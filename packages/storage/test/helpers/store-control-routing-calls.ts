/**
 * The cases of the adapter routing test's `CALLS` list (store-control-routing.test.ts) and the TripleStore methods each one
 * drives, as plain data. The routing test checks that its `CALLS` has exactly these cases and that each case reaches exactly
 * these methods; the publisher's share-queue oracle (async-promote-share-control-oracle.test.ts) checks that the store
 * methods a queue call may use are exactly the union of them. A case added to or removed from `CALLS` therefore fails one of
 * the two until this list follows it.
 */
export const ROUTING_CALL_METHODS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'query (SELECT)': ['query'],
  'query (ASK)': ['query'],
  'insert': ['insert'],
  'delete': ['delete'],
  'deleteByPattern (count, delete, count)': ['deleteByPattern'],
  'deleteByPatternWithoutCount': ['deleteByPatternWithoutCount'],
  'deleteBySubjectPrefix (count, delete, count)': ['deleteBySubjectPrefix'],
  'replaceSubject': ['replaceSubject'],
  'replaceSubjectAndInsert': ['replaceSubjectAndInsert'],
  'replaceSubject or its delete-then-insert fallback': ['replaceSubject', 'deleteByPatternWithoutCount', 'insert'],
  'update': ['update'],
  'createGraph (takes no options)': ['createGraph'],
  'flush': ['flush'],
});

/** Every TripleStore method some case drives, sorted. */
export const ROUTING_DRIVEN_METHODS: readonly string[] = Object.freeze(
  [...new Set(Object.values(ROUTING_CALL_METHODS).flat())].sort(),
);
