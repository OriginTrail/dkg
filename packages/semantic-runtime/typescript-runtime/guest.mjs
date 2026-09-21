export { pipe, map, reduce } from 'pipeline';
let nextId = 0;
let outgoing = [];
const waiting = new Map();
let running = false;
export function begin() { running = true; }
export function invoke_program(program, args) {
  if (!running) throw new Error('invoke_program must be called from the run entrypoint');
  if (typeof program !== 'string' || !Array.isArray(args)) throw new Error('invoke_program expects an IRI and argument array');
  const id = ++nextId;
  outgoing.push({ id, program, args });
  return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); });
}
export function complete(id, json) {
  const waiter = waiting.get(id);
  if (!waiter) throw new Error('Unknown or duplicate completion');
  waiting.delete(id);
  const response = JSON.parse(json);
  if (response.ok) waiter.resolve(response.value);
  else waiter.reject(new Error(response.error));
}
export function takeEffects() {
  const effects = outgoing;
  outgoing = [];
  return effects;
}
