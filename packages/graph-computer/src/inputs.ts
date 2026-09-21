/** JSON argument snapshot shared by HTTP payloads, signatures and retry handles. */
export function canonicalInputs(value: unknown): string {
  if (!Array.isArray(value)) throw new TypeError('inputs must be a JSON array');
  const seen = new Set<object>();
  function encode(value: unknown, depth: number): string {
    if (depth > 20) throw new TypeError('inputs exceed nesting limit');
    if (value === null || typeof value === 'boolean') return String(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (typeof value === 'string') {
      if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new TypeError('Invalid Unicode');
      return JSON.stringify(value);
    }
    if (!value || typeof value !== 'object' || seen.has(value) || depth === 20) throw new TypeError('inputs must contain only JSON values');
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length) throw new TypeError('Sparse arrays are not JSON arguments');
        return '[' + value.map(entry => encode(entry, depth + 1)).join(',') + ']';
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('inputs must contain plain JSON objects');
      return '{' + Object.keys(value).sort().map(key => `${encode(key, depth + 1)}:${encode((value as Record<string, unknown>)[key], depth + 1)}`).join(',') + '}';
    } finally { seen.delete(value); }
  }
  const json = encode(value, 0);
  if (new TextEncoder().encode(json).byteLength > 65536) throw new TypeError('inputs exceed 64 KiB');
  return json;
}
