import { sha256Hex, UTF8 } from './canonical.ts';
import {
  GATE_EVALUATION,
  PRODUCT_BOUNDARY,
  RAW_SCHEMA_ID,
  type AssetRowV1,
  type RawEvidenceV1,
} from './schema.ts';
import { computeInventorySetRoot } from './set-root.ts';

// Fixed decimal width so the canonical ual string order matches numeric order.
const UAL_INDEX_WIDTH = 6;

function deterministicRow(index: number): AssetRowV1 {
  const id = String(index).padStart(UAL_INDEX_WIDTH, '0');
  const ual = `did:dkg:gate2-mac-fixture/${id}`;
  // Content and bundle bytes are a pure function of the index: reproducible on
  // any host with no clock, randomness, or environment input.
  const content = UTF8.encode(`gate2-mac:content:${id}:${'ka'.repeat(index + 1)}`);
  const bundle = UTF8.encode(`gate2-mac:bundle:${id}:${sha256Hex(content)}`);
  return Object.freeze({
    ual,
    contentDigest: sha256Hex(content),
    contentLength: content.byteLength,
    bundleDigest: sha256Hex(bundle),
    bundleLength: bundle.byteLength,
  });
}

function byUal(a: AssetRowV1, b: AssetRowV1): number {
  if (a.ual < b.ual) return -1;
  if (a.ual > b.ual) return 1;
  return 0;
}

/**
 * Deterministically generate a COMPLETE multi-asset completeness fixture of
 * `count` assets: authored and received are the identical canonical-ordered row
 * set, `totalCount` is exact, and `inventorySetRoot` is computed from the
 * authored set. Byte-identical across runs for the same `count`.
 */
export function generateCompleteFixture(count: number): RawEvidenceV1 {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError(`fixture asset count must be a positive safe integer, got ${String(count)}`);
  }
  const rows: AssetRowV1[] = [];
  for (let index = 0; index < count; index += 1) rows.push(deterministicRow(index));
  const authored = Object.freeze([...rows].sort(byUal));
  const received = Object.freeze([...rows].sort(byUal));
  return Object.freeze({
    schema: RAW_SCHEMA_ID,
    productBoundary: PRODUCT_BOUNDARY,
    gateEvaluation: GATE_EVALUATION,
    authored,
    received,
    totalCount: authored.length,
    inventorySetRoot: computeInventorySetRoot(authored),
  });
}
