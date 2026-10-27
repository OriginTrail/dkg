/** This block delegates to an approved Graph Computer Program, rather than evaluating editor text. */
export const programDescriptor = Object.freeze({
  id: 'run-program', name: 'Run Program KA', category: 'Programs', nodeType: 'dkg.program', version: 2,
  input: 'items', outputs: ['main'], mode: 'program', sampleItems: [{ value: 12 }],
  parameters: {
    operationIri: { type: 'string', label: 'Approved operation', default: 'urn:unselected:program', maxLength: 240 },
    version: { type: 'string', label: 'Program version', default: '1.0.0', maxLength: 80 },
    inputMode: { type: 'string', label: 'Run mode', default: 'each-item', maxLength: 20, options: ['each-item', 'all-items'] },
    inputMapping: { type: 'json', label: 'Program input mapping', default: '{{ $json }}', maxLength: 1600, shape: 'any' },
  },
});

export function programRecords(value) {
  const rows = (Array.isArray(value) ? value : [value]).map(row => row !== null && typeof row === 'object' && !Array.isArray(row) ? row : { value: row });
  const inspect = (item, depth = 0) => {
    if (depth > 8 || item === undefined || typeof item === 'number' && !Number.isFinite(item)) throw new Error('Program output must be bounded JSON.');
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || key.startsWith('__nos')) throw new Error('Reserved program output field.');
      inspect(child, depth + 1);
    }
  };
  inspect(rows);
  if (rows.length > 20 || JSON.stringify(rows).length > 8192) throw new Error('Program output exceeds twenty records / 8 KiB.');
  return rows;
}
