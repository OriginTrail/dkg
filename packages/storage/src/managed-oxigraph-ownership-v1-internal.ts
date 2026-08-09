/**
 * Source-compatibility shim for storage-internal imports.
 *
 * The canonical implementation and the package's explicit internal entry point
 * live under `src/internal/`. Keeping this forwarding module avoids unrelated
 * import churn while ensuring every consumer shares the same private authority
 * table from one module instance.
 */
export * from './internal/managed-oxigraph-ownership-v1.js';
