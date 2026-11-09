import { jpbReadSpec, normalizeJpbRead, validateJpbReadRequest } from './jpb-read-policy.mjs';

export async function readJpbThroughNos(call, payload) {
  validateJpbReadRequest(payload);
  return normalizeJpbRead(await call('query', jpbReadSpec.query));
}
