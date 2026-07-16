export const EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION =
  'Use the injected target context graph id/URI when present; otherwise use ' +
  'an exact existing context graph id from dkg_list_context_graphs, or its ' +
  'full did:dkg:context-graph:<id> URI. Locally-created context graphs ' +
  'may have ids like "local-notes"; joined/curated context graphs use ' +
  '<curatorAddress>/<slug> ids like "0x.../team-notes". Do not guess, ' +
  'shorten, or pass only the suffix slug for curator-scoped graphs.';
