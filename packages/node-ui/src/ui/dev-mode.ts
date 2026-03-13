const DEV_MODE_KEY = 'dkg-developer-mode';

export function isDevModeEnabled(): boolean {
  try { return localStorage.getItem(DEV_MODE_KEY) === '1'; } catch { return false; }
}

export function setDevModeEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(DEV_MODE_KEY, '1');
    else localStorage.removeItem(DEV_MODE_KEY);
  } catch { /* ignore */ }
  window.dispatchEvent(new Event('devmode-change'));
}
