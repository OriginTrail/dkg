export function run(value: unknown, factor: unknown) {
  if (typeof value !== 'number' || typeof factor !== 'number') throw new Error('Expected two numbers');
  return value * factor;
}
