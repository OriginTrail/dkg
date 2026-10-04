import { readFileSync } from 'node:fs';
import { parseObservation, assertObservation, resultExit } from './query-observation.mjs';
// stdin: curl exit status LF HTTP status LF response body. No credentials in diagnostics.
const [mode, binding = 'cnt', format = 'api', operator, expected] = process.argv.slice(2);
const input = readFileSync(0, 'utf8');
const first = input.indexOf('\n'), second = input.indexOf('\n', first + 1);
const transport = input.slice(0, first), http = input.slice(first + 1, second);
let result = parseObservation({
  transportExit: first >= 0 && /^[0-9]+$/.test(transport) ? Number(transport) : null,
  httpStatus: second >= 0 && /^[0-9]{3}$/.test(http) ? Number(http) : null,
  body: input.slice(second + 1), mode, binding, format,
});
if (operator !== undefined) result = assertObservation(result, operator, expected ?? '');
if (result.outcome === 'PASS') {
  if (mode === 'json') console.log(JSON.stringify({ result: { type: 'bindings', bindings: result.rows } }));
  else if (mode === 'bindings') console.log(JSON.stringify(result.rows));
  else console.log(result.value);
} else console.error(JSON.stringify({ outcome: result.outcome, reason: result.reason }));
process.exitCode = resultExit(result);
