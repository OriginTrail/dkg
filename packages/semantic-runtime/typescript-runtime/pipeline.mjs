export async function pipe(value, ...stages) {
  let result = await value;
  for (const stage of stages) result = await stage(result);
  return result;
}
export function map(fn, { concurrency = 4 } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Invalid map concurrency');
  return async value => {
    if (!Array.isArray(value)) throw new Error('map expects an array');
    const results = new Array(value.length);
    let next = 0, failed = false, failure;
    await Promise.all(Array.from({ length: Math.min(concurrency, value.length) }, async () => {
      while (!failed) {
        const index = next++;
        if (index >= value.length) return;
        try { results[index] = await fn(value[index], index); }
        catch (error) { if (!failed) { failed = true; failure = error; } }
      }
    }));
    if (failed) throw failure;
    return results;
  };
}
export function reduce(fn, initial) {
  return async value => {
    if (!Array.isArray(value)) throw new Error('reduce expects an array');
    let result = initial;
    for (const row of value) result = await fn(result, row);
    return result;
  };
}
