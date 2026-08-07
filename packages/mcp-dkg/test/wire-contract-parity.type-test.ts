// Compile-time wire-contract parity: mcp-dkg keeps a LOCAL mirror of the dRAG
// citation shape (the published package is deliberately dependency-light and
// must not pull @origintrail-official/dkg-core at runtime), so this file binds
// the mirror to the canonical type at BUILD time instead. It is checked by
// `tsc -p tsconfig.typecheck.json` in the package's `test` script (NOT by
// vitest, which transpiles without type-checking): if dkg-core's
// VerifiableCitation gains/renames/retypes a field — or the mirror does —
// one of the assignments below stops compiling and CI fails. dkg-core is a
// devDependency only; nothing here is emitted or published.
import type { VerifiableCitation } from '@origintrail-official/dkg-core';
import type { DragCitation } from '../src/client.js';

declare const canonical: VerifiableCitation;
declare const mirror: DragCitation;

// The mirror accepts every canonical citation (a core field ADDITION breaks this):
const mirrorFromCanonical: DragCitation = canonical;

// The mirror adds nothing the canonical type lacks (a mirror field ADDITION breaks this):
const canonicalFromMirror: VerifiableCitation = mirror;

export { mirrorFromCanonical, canonicalFromMirror };
