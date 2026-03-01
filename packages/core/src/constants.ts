export const PROTOCOL_PUBLISH = '/dkg/publish/1.0.0';
export const PROTOCOL_QUERY = '/dkg/query/1.0.0';
export const PROTOCOL_DISCOVER = '/dkg/discover/1.0.0';
export const PROTOCOL_SYNC = '/dkg/sync/1.0.0';
export const PROTOCOL_MESSAGE = '/dkg/message/1.0.0';
export const PROTOCOL_ACCESS = '/dkg/access/1.0.0';
export const PROTOCOL_QUERY_REMOTE = '/dkg/query/2.0.0';

export const DHT_PROTOCOL = '/dkg/kad/1.0.0';

export function paranetPublishTopic(paranetId: string): string {
  return `dkg/paranet/${paranetId}/publish`;
}

export function paranetAgentsTopic(paranetId: string): string {
  return `dkg/paranet/${paranetId}/agents`;
}

export function networkPeersTopic(): string {
  return 'dkg/network/peers';
}

export function paranetDataGraphUri(paranetId: string): string {
  return `did:dkg:paranet:${paranetId}`;
}

export function paranetMetaGraphUri(paranetId: string): string {
  return `did:dkg:paranet:${paranetId}/_meta`;
}

export function paranetPrivateGraphUri(paranetId: string): string {
  return `did:dkg:paranet:${paranetId}/_private`;
}

export function paranetWorkspaceGraphUri(paranetId: string): string {
  return `did:dkg:paranet:${paranetId}/_workspace`;
}

export function paranetWorkspaceMetaGraphUri(paranetId: string): string {
  return `did:dkg:paranet:${paranetId}/_workspace_meta`;
}

export function paranetWorkspaceTopic(paranetId: string): string {
  return `dkg/paranet/${paranetId}/workspace`;
}
