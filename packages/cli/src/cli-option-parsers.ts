export function parseOptionalPositiveInteger(raw: unknown, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  return parsePositiveIntegerValue(String(raw), flag);
}

export function parsePositiveMsOption(value: string, optionName: '--poll-interval' | '--error-backoff'): number {
  return parsePositiveIntegerValue(value, optionName, 'positive integer in milliseconds');
}

export function parsePositiveIntegerOption(value: string, optionName: string): number {
  return parsePositiveIntegerValue(value, optionName);
}

function parsePositiveIntegerValue(
  value: string,
  optionName: string,
  expectation = 'positive integer',
): number {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${optionName} must be a ${expectation}`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${optionName} must be a ${expectation}`);
  }
  return parsed;
}
