/**
 * Make the browser refuse tab storage the way real browsers do, and return a
 * function that restores the real `window.sessionStorage`.
 *
 * - `blocked`: reading `window.sessionStorage` throws a SecurityError, as when
 *   site data is blocked.
 * - `writesFail`: reads work but writes throw a QuotaExceededError, as in some
 *   private browsing modes.
 *
 * Overriding the property (rather than spying on `Storage.prototype`) is what
 * the code under test actually observes in happy-dom.
 */
export function refuseTabStorage(mode: 'blocked' | 'writesFail'): () => void {
  const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
  const real = window.sessionStorage;
  const get = mode === 'blocked'
    ? () => { throw new DOMException('The operation is insecure.', 'SecurityError'); }
    : () => ({
        getItem: (key: string) => real.getItem(key),
        setItem: () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); },
        removeItem: (key: string) => real.removeItem(key),
        clear: () => real.clear(),
        key: (index: number) => real.key(index),
        get length() { return real.length; },
      }) as Storage;
  Object.defineProperty(window, 'sessionStorage', { configurable: true, get });
  return () => {
    if (original) Object.defineProperty(window, 'sessionStorage', original);
  };
}
