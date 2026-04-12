export interface ExtractionStatusRecord {
  status: 'in_progress' | 'completed' | 'skipped' | 'failed';
  // `keccak256:<hex>` — canonical per spec §10.2:603 / 03 §2.1:658.
  fileHash: string;
  rootEntity?: string;
  detectedContentType: string;
  pipelineUsed: string | null;
  tripleCount: number;
  // `keccak256:<hex>` — present only when Phase 1 actually ran (PDF/
  // DOCX via MarkItDown). Undefined for pure-markdown imports.
  mdIntermediateHash?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export const EXTRACTION_STATUS_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_EXTRACTION_STATUS_RECORDS = 1000;

function extractionStatusSortKey(record: ExtractionStatusRecord): number {
  const completedAtMs = record.completedAt ? Date.parse(record.completedAt) : Number.NaN;
  if (Number.isFinite(completedAtMs)) return completedAtMs;
  const startedAtMs = Date.parse(record.startedAt);
  return Number.isFinite(startedAtMs) ? startedAtMs : 0;
}

export function pruneExtractionStatusRecords(
  extractionStatus: Map<string, ExtractionStatusRecord>,
  nowMs = Date.now(),
): void {
  for (const [assertionUri, record] of extractionStatus.entries()) {
    const ageRefMs = extractionStatusSortKey(record);
    if (ageRefMs > 0 && nowMs - ageRefMs > EXTRACTION_STATUS_TTL_MS) {
      extractionStatus.delete(assertionUri);
    }
  }

  if (extractionStatus.size <= MAX_EXTRACTION_STATUS_RECORDS) return;

  const oldestFirst = [...extractionStatus.entries()].sort(
    ([, left], [, right]) => extractionStatusSortKey(left) - extractionStatusSortKey(right),
  );

  for (const [assertionUri, record] of oldestFirst) {
    if (extractionStatus.size <= MAX_EXTRACTION_STATUS_RECORDS) break;
    if (record.status !== 'in_progress') {
      extractionStatus.delete(assertionUri);
    }
  }
}

export function setExtractionStatusRecord(
  extractionStatus: Map<string, ExtractionStatusRecord>,
  assertionUri: string,
  record: ExtractionStatusRecord,
): void {
  extractionStatus.set(assertionUri, record);
  pruneExtractionStatusRecords(extractionStatus);
}

export function getExtractionStatusRecord(
  extractionStatus: Map<string, ExtractionStatusRecord>,
  assertionUri: string,
): ExtractionStatusRecord | undefined {
  pruneExtractionStatusRecords(extractionStatus);
  return extractionStatus.get(assertionUri);
}
