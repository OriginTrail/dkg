import { run } from 'user-program';
import { begin, complete, takeEffects } from 'guest';
let started = false, terminal = null;
export function start(inputJson) {
  if (started) throw new Error('Execution already started');
  started = true;
  begin();
  Promise.resolve().then(() => run(...JSON.parse(inputJson))).then(
    value => { terminal = { ok: true, value }; },
    error => { terminal = { ok: false, error: String(error) }; },
  );
}
export function settle(id, responseJson) { complete(id, responseJson); }
export function inspect() {
  return JSON.stringify({ effects: takeEffects(), terminal }, (_key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)
      || ['undefined', 'function', 'symbol', 'bigint'].includes(typeof value)) throw new Error('Program values must be JSON');
    return value;
  });
}
