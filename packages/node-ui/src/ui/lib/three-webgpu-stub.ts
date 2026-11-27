/**
 * Stands in for `three/webgpu` in the node UI build.
 *
 * three-render-objects imports WebGPURenderer statically but only constructs
 * it when a graph is created with `useWebGPU: true`. graph-viz never asks for
 * it, so the graph always renders with WebGL. Bundling the real module would
 * add three.js's 2 MB WebGPU build to every node UI build, which the node runs
 * itself on small machines within a fixed memory budget (see `build:ui`).
 *
 * To turn WebGPU on, remove the `three/webgpu` alias in vite.config.ts.
 */
export class WebGPURenderer {
  constructor() {
    throw new Error('The WebGPU renderer is not included in the node UI build.');
  }
}
