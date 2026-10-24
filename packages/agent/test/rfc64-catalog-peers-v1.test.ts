import { describe, expect, it } from 'vitest';

import {
  snapshotRfc64RemoteCatalogAnnouncementPeersV1,
} from '../src/rfc64/catalog-peers-v1.js';

describe('RFC-64 catalog announcement peers', () => {
  it('removes the local peer while preserving remote fan-out order', () => {
    const input = ['peer-a', 'self-peer', 'peer-b'];

    const peers = snapshotRfc64RemoteCatalogAnnouncementPeersV1(input, 'self-peer');

    expect(peers).toEqual(['peer-a', 'peer-b']);
    expect(Object.isFrozen(peers)).toBe(true);
    expect(input).toEqual(['peer-a', 'self-peer', 'peer-b']);
  });

  it('retains canonical peer-list validation before filtering', () => {
    expect(() => snapshotRfc64RemoteCatalogAnnouncementPeersV1(
      ['self-peer', 'self-peer'],
      'self-peer',
    )).toThrow(/duplicated/u);
  });
});
