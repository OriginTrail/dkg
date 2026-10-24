/**
 * Node-local KA controls deliberately live outside every context-graph prefix,
 * so durable sync neither serves nor ingests them as peer metadata.
 */
export const LOCAL_TRUSTED_KA_CONTROLS_GRAPH = 'urn:dkg:local:trusted-ka-controls';
