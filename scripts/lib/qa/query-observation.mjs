// Pure parser for the DKG /api/query envelope and SPARQL Results JSON.
// COUNT accepts the numeric subset emitted by formatCanonicalRdfTerm in
// rdf-utils: bare decimal strings or canonical quoted XSD integer terms.
// It deliberately does not extract digits or coerce unknown RDF terms.
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const integerTypes = new Map([
  ['integer', [null, null]], ['nonNegativeInteger', [0n, null]],
  ['positiveInteger', [1n, null]], ['nonPositiveInteger', [null, 0n]],
  ['negativeInteger', [null, -1n]],
  ['long', [-(2n ** 63n), 2n ** 63n - 1n]],
  ['int', [-(2n ** 31n), 2n ** 31n - 1n]],
  ['short', [-32768n, 32767n]], ['byte', [-128n, 127n]],
  ['unsignedLong', [0n, 2n ** 64n - 1n]], ['unsignedInt', [0n, 2n ** 32n - 1n]],
  ['unsignedShort', [0n, 65535n]], ['unsignedByte', [0n, 255n]],
]);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const own = (x, k) => Object.hasOwn(x, k);
const invalid = reason => ({ outcome: 'INCONCLUSIVE', reason });
const apiError = x => own(x, 'error') || own(x, 'errors') || x.ok === false
  || x.success === false || (own(x, 'status') && !['ok', 'success'].includes(x.status));
export const resultExit = result => result.outcome === 'PASS' ? 0 : result.outcome === 'FAIL' ? 1 : 2;

export function countValue(cell) {
  let lexical, datatype;
  if (typeof cell === 'string') {
    if (/^\+?[0-9]+$/.test(cell)) lexical = cell;
    else {
      const term = /^"(\+?[0-9]+)"\^\^<([^<>]+)>$/.exec(cell);
      if (!term) return null;
      [, lexical, datatype] = term;
    }
  } else if (object(cell) && ['literal', 'typed-literal'].includes(cell.type)
    && typeof cell.value === 'string' && typeof cell.datatype === 'string'
    && Object.keys(cell).every(k => ['type', 'value', 'datatype'].includes(k))) {
    lexical = cell.value;
    datatype = cell.datatype;
  } else return null;
  if (!/^\+?[0-9]+$/.test(lexical)) return null;
  const value = BigInt(lexical);
  if (datatype !== undefined) {
    const range = datatype.startsWith(XSD) ? integerTypes.get(datatype.slice(XSD.length)) : undefined;
    if (!range || (range[0] !== null && value < range[0]) || (range[1] !== null && value > range[1])) return null;
  }
  return value.toString();
}

const controlOrSpace = value => [...value].some(c => c.codePointAt(0) <= 0x20 || c.codePointAt(0) === 0x7F);
const safeIri = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  && !controlOrSpace(value) && !/[<>"{}|\\^`]/.test(value);

function validCell(cell) {
  if (typeof cell === 'string') return cell.length > 0;
  if (!object(cell) || typeof cell.value !== 'string') return false;
  if (!['uri', 'bnode', 'literal', 'typed-literal'].includes(cell.type)) return false;
  if (cell.type === 'uri' && (!safeIri(cell.value) || Object.keys(cell).some(k => !['type', 'value'].includes(k)))) return false;
  if (cell.type === 'bnode' && (!cell.value || controlOrSpace(cell.value) || /[<>"{}|\\^`]/.test(cell.value) || Object.keys(cell).some(k => !['type', 'value'].includes(k)))) return false;
  if (cell.type === 'typed-literal' && typeof cell.datatype !== 'string') return false;
  return Object.keys(cell).every(k => ['type', 'value', 'datatype', 'xml:lang'].includes(k))
    && !(own(cell, 'datatype') && own(cell, 'xml:lang'))
    && (!own(cell, 'datatype') || safeIri(cell.datatype))
    && (!own(cell, 'xml:lang') || (typeof cell['xml:lang'] === 'string' && /^[A-Za-z]+(?:-[A-Za-z0-9]+)*$/.test(cell['xml:lang'])));
}

export function parseObservation({ transportExit, httpStatus, body, format = 'api', mode = 'count', binding = 'cnt' }) {
  if (transportExit !== 0) return invalid('TRANSPORT_FAILURE');
  if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300) return invalid('HTTP_ERROR');
  let envelope;
  try { envelope = JSON.parse(body); } catch { return invalid('MALFORMED_JSON'); }
  if (!object(envelope)) return invalid('INVALID_ENVELOPE');
  if (apiError(envelope)) return invalid('API_ERROR');
  let rows;
  if (format === 'api') {
    const result = envelope.result;
    if (object(result) && apiError(result)) return invalid('API_ERROR');
    if (!object(result) || (own(result, 'type') && result.type !== 'bindings')
      || own(result, 'quads') || own(result, 'value')) return invalid('INVALID_RESULT');
    rows = result.bindings;
  } else if (format === 'sparql') {
    if (!object(envelope.head) || !Array.isArray(envelope.head.vars)
      || !envelope.head.vars.every(v => typeof v === 'string')
      || new Set(envelope.head.vars).size !== envelope.head.vars.length
      || !object(envelope.results)) return invalid('INVALID_RESULT');
    if (apiError(envelope.results)) return invalid('API_ERROR');
    if (binding && !envelope.head.vars.includes(binding)) return invalid('MISSING_BINDING');
    rows = envelope.results.bindings;
    if (Array.isArray(rows) && rows.some(row => object(row)
      && Object.keys(row).some(k => !envelope.head.vars.includes(k)))) return invalid('INVALID_BINDINGS');
  } else return invalid('UNSUPPORTED_FORMAT');
  if (!Array.isArray(rows) || rows.some(row => !object(row)
    || Object.values(row).some(cell => (format === 'sparql' && !object(cell)) || !validCell(cell)))) return invalid('INVALID_BINDINGS');
  if (binding && rows.some(row => !own(row, binding))) return invalid('MISSING_BINDING');
  if (mode === 'count') {
    if (!binding) return invalid('MISSING_BINDING');
    if (rows.length !== 1) return invalid('AMBIGUOUS_COUNT_ROWS');
    const value = countValue(rows[0][binding]);
    if (value === null) return invalid('INVALID_COUNT');
    return { outcome: 'PASS', reason: 'VALID_OBSERVATION', value };
  }
  if (mode === 'rows' || mode === 'json') return {
    outcome: 'PASS', reason: 'VALID_OBSERVATION', value: String(rows.length), rows,
  };
  return invalid('UNSUPPORTED_MODE');
}

export function assertObservation(observation, operator, expected) {
  if (observation.outcome !== 'PASS') return observation;
  if (!['eq', 'ge'].includes(operator) || !/^[0-9]+$/.test(expected)) return invalid('INVALID_ASSERTION');
  const actual = BigInt(observation.value), target = BigInt(expected);
  const passed = operator === 'eq' ? actual === target : actual >= target;
  return { outcome: passed ? 'PASS' : 'FAIL', reason: passed ? 'ASSERTION_SATISFIED' : 'ASSERTION_FAILED', value: observation.value };
}
