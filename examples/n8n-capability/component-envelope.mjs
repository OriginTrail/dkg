/** Structural invocation boundary, independent of any native component semantics. */
export const invalidComponentValue = message => { throw new Error(message); };
export const componentRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function inspectComponentValue(value, depth = 0) {
  if (depth > 8) invalidComponentValue('Input is nested too deeply.');
  if (typeof value === 'number' && !Number.isFinite(value)) invalidComponentValue('Use finite JSON numbers.');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || key.startsWith('__nos')) invalidComponentValue('Reserved input field.');
    inspectComponentValue(child, depth + 1);
  }
}

export function normalizeComponentEnvelope(value) {
  if (!componentRecord(value) || Object.keys(value).some(key => !['itemsJson', 'paramsJson', 'executionId'].includes(key))
    || typeof value.itemsJson !== 'string' || value.itemsJson.length > 8192
    || typeof value.paramsJson !== 'string' || value.paramsJson.length > 2048)
    invalidComponentValue('Use bounded component input.');
  const items = JSON.parse(value.itemsJson), params = JSON.parse(value.paramsJson);
  if (!Array.isArray(items) || items.length > 20 || !items.every(componentRecord))
    invalidComponentValue('Supply up to twenty JSON records and component parameters.');
  if (!componentRecord(params)) invalidComponentValue('Supply component parameters as a JSON object.');
  inspectComponentValue(items);
  inspectComponentValue(params);
  const executionId = value.executionId ?? '';
  if (typeof executionId !== 'string' || executionId && !/^\d{1,20}$/.test(executionId))
    invalidComponentValue('Invalid provider execution identity.');
  return { itemsJson: JSON.stringify(items), paramsJson: JSON.stringify(params), executionId };
}
