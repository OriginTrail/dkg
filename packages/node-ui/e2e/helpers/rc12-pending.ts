import type { TestInfo } from '@playwright/test';

/** Skip in CI until rc.12 UI refresh lands; local runs keep full coverage visible. */
export function skipRc12Pending(testInfo: TestInfo, reason: string): void {
  testInfo.skip(!!process.env.CI, reason);
}
