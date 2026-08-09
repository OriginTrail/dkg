/**
 * Public failure contract for a managed store that cannot prove ownership of
 * its Oxigraph backend. The ownership mint remains package-internal; callers
 * only need this class to recognize the fail-closed result from public APIs.
 */
export class ManagedOxigraphBackendUnownedError extends Error {
  readonly code = 'MANAGED_OXIGRAPH_BACKEND_UNOWNED' as const;

  constructor(
    readonly operation: string,
    readonly terminal: boolean,
    readonly lastInvalidation?: string,
  ) {
    super(
      `${operation} refused: the managed Oxigraph child is not the proven ready listener ` +
        `(terminal=${terminal}${lastInvalidation ? `, ${lastInvalidation}` : ''}). ` +
        'The request was not dispatched.',
    );
    this.name = 'ManagedOxigraphBackendUnownedError';
  }
}
