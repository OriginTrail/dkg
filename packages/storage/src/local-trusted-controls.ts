/**
 * Node-local KA controls are deliberately outside every context-graph prefix,
 * so durable sync never serves or ingests them as peer metadata.
 */
export const LOCAL_TRUSTED_KA_CONTROLS_GRAPH = 'urn:dkg:local:trusted-ka-controls';
