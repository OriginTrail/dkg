// Compatibility wrapper: discovery, focused tests and exception metadata share one scanner.
import { analyzeTestSource } from './disabled-test-scanner.mjs';
export function inspectTestExceptions(source, filename, now = new Date()) {
  const { focused, invalidExceptions } = analyzeTestSource(source, filename, { now });
  return { focused, invalidExceptions };
}
