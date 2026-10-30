/** Check before starting a partition or admitting a Program into a Worker. */
export function assertSemanticRuntimeSupport(): void {
  const wasm = WebAssembly as typeof WebAssembly & {
    Suspending?: unknown;
    promising?: unknown;
  };
  if (typeof wasm.Suspending !== 'function' || typeof wasm.promising !== 'function') {
    throw new Error(
      'semantic runtime execution requires WebAssembly JSPI '
      + '(WebAssembly.Suspending and WebAssembly.promising); '
      + `use Node.js 26 or newer (current runtime: ${process.version})`,
    );
  }
}
