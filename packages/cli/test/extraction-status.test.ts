import { describe, expect, it } from 'vitest';
import {
  MAX_EXTRACTION_STATUS_RECORDS,
  pruneExtractionStatusRecords,
  type ExtractionStatusRecord,
} from '../src/extraction-status.js';

const BASE_MS = Date.UTC(2026, 3, 10, 12, 0, 0);

function makeRecord(status: ExtractionStatusRecord['status'], index: number): ExtractionStatusRecord {
  const startedAt = new Date(BASE_MS + (index * 1000)).toISOString();
  const hex = index.toString(16).padStart(64, '0');
  return {
    status,
    fileHash: `keccak256:${hex}`,
    detectedContentType: 'text/markdown',
    pipelineUsed: status === 'skipped' ? null : 'text/markdown',
    tripleCount: 0,
    startedAt,
    ...(status === 'in_progress' ? {} : { completedAt: new Date(BASE_MS + (index * 1000) + 500).toISOString() }),
  };
}

describe('extraction-status pruning', () => {
  it('does not evict in-progress records when only active jobs remain above capacity', () => {
    const status = new Map<string, ExtractionStatusRecord>();
    for (let i = 0; i < MAX_EXTRACTION_STATUS_RECORDS + 1; i += 1) {
      status.set(`assertion-${i}`, makeRecord('in_progress', i));
    }

    pruneExtractionStatusRecords(status, BASE_MS + ((MAX_EXTRACTION_STATUS_RECORDS + 2) * 1000));

    expect(status.size).toBe(MAX_EXTRACTION_STATUS_RECORDS + 1);
    expect(status.has('assertion-0')).toBe(true);
    expect([...status.values()].every(record => record.status === 'in_progress')).toBe(true);
  });

  it('evicts completed records before active ones when capacity is exceeded', () => {
    const status = new Map<string, ExtractionStatusRecord>();
    for (let i = 0; i < 5; i += 1) {
      status.set(`active-${i}`, makeRecord('in_progress', i));
    }
    for (let i = 0; i < MAX_EXTRACTION_STATUS_RECORDS; i += 1) {
      status.set(`completed-${i}`, makeRecord('completed', i + 10));
    }

    pruneExtractionStatusRecords(status, BASE_MS + ((MAX_EXTRACTION_STATUS_RECORDS + 20) * 1000));

    expect(status.size).toBe(MAX_EXTRACTION_STATUS_RECORDS);
    for (let i = 0; i < 5; i += 1) {
      expect(status.has(`active-${i}`)).toBe(true);
    }
  });
});
