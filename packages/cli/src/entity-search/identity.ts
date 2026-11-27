import { createHash } from 'node:crypto';
import type { EntityIndexSpec, EntityIdentity } from './types.js';

export function indexKey(spec: EntityIndexSpec, fingerprint: string): string {
  return createHash('sha256').update(JSON.stringify([spec, fingerprint])).digest('hex');
}
export function documentKey(doc: EntityIdentity): string {
  return JSON.stringify([doc.sourceGraph, doc.entityUri]);
}
