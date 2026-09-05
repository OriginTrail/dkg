// Shared by Vitest instrumentation and the independent report validator.
// Prime Agent ships extension/src as well as src; sourcemaps retain that path.
export const COVERAGE_SOURCE_ROOTS = ['src', 'extension/src'];
export const COVERAGE_SOURCE_GLOBS = COVERAGE_SOURCE_ROOTS.map((root) => `${root}/**/*.{ts,tsx,js,jsx,mjs,cjs}`);
