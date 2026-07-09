#!/usr/bin/env node
/**
 * DISABLED (#1087) — pending the #1260 named-KA rework.
 *
 * This script drained SWM by re-publishing already-verified entities via the
 * loose publish-by-`selection` SWM-publish route, which was REMOVED in #1087.
 * The drain was its entire purpose, so the script is hard-disabled below: it
 * exits non-zero BEFORE doing any work (no daemon connection / scan / batch
 * loop) so an operator cannot mistake discovery or progress output for an
 * active drain.
 *
 * Note: a named KA already self-drains its own roots from SWM when published to
 * VM (the per-KA `/vm/publish` path), so a standalone drain may be obsolete
 * entirely. If one is still needed, re-implement it on the named-KA model under
 * #1260. The previous scan-and-evict implementation is in git history.
 */

console.error('[drain-swm-duplicates] DISABLED (#1087): the SWM drain relied on the removed loose');
console.error('  publish-by-selection route. A named KA self-drains its own SWM roots on /vm/publish,');
console.error('  so this maintenance step may be obsolete; re-implement on the named-KA model under');
console.error('  #1260 if a standalone drain is still required.');
process.exit(1);
