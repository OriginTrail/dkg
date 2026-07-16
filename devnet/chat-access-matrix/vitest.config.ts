import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    include: [resolve(import.meta.dirname, "automated.test.ts")],
    testTimeout: 300_000,
    hookTimeout: 180_000,
    pool: "forks",
    sequence: { concurrent: false },
    globals: false,
  },
});
