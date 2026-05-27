export const EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION =
  'Exact existing context graph id returned by dkg_list_context_graphs, ' +
  'or its full did:dkg:context-graph:<id> URI. Locally-created context graphs ' +
  'may have ids like "ui-refresh"; joined/curated context graphs use ' +
  '<curatorAddress>/<slug> ids like "0x.../tuesday-cg". Do not guess, ' +
  'shorten, or pass only the suffix slug for curator-scoped graphs.';
