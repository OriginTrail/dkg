import type { PublicGraphSnapshot } from '../dist/public-graph-snapshot.js';

declare const snapshot: PublicGraphSnapshot;
// @ts-expect-error Accepted snapshot scope is pinned.
snapshot.contextGraphId = 'other';
// @ts-expect-error Accepted inventory cannot be replaced.
snapshot.assets = [];
// @ts-expect-error Accepted inventory cannot grow.
snapshot.assets.push({ id: '1', root: 'other', version: '1' });
// @ts-expect-error Accepted asset authentication facts are pinned.
snapshot.assets[0]!.root = 'other';
