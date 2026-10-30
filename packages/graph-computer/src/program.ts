/** Invoke a declared tool through the host's current approval and effect broker. */
export function invoke_tool(_toolIri: string, _input: unknown): Promise<unknown> {
  throw new Error('invoke_tool is available inside compiled Graph Computer Programs');
}
/** Guest-only API. The TypeScript Program compiler supplies the implementation. */
export function invoke_program(_program: string, _args: unknown[]): Promise<unknown> {
  throw new Error('invoke_program is available inside compiled Graph Computer Programs');
}
type Stage = (value: unknown) => unknown | Promise<unknown>;
export function pipe(_value: unknown, ..._stages: Stage[]): Promise<unknown> {
  throw new Error('pipe is available inside compiled Graph Computer Programs');
}
export function map(_fn: (row: unknown, index: number) => unknown | Promise<unknown>, _options?: { concurrency?: number }): Stage {
  throw new Error('map is available inside compiled Graph Computer Programs');
}
export function reduce(_fn: (accumulator: unknown, row: unknown) => unknown | Promise<unknown>, _initial: unknown): Stage {
  throw new Error('reduce is available inside compiled Graph Computer Programs');
}
