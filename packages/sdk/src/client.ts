import { HttpClient } from './http.js';
import { NodeResource } from './resources/node.js';
import { ParanetResource } from './resources/paranet.js';
import { PublishResource } from './resources/publish.js';
import type { DKGClientOptions, DKGSDK } from './types.js';

export function createDKG(options: DKGClientOptions): DKGSDK {
  const http = new HttpClient(options);

  return {
    node: new NodeResource(http),
    paranet: new ParanetResource(http),
    publish: new PublishResource(http),
  };
}
