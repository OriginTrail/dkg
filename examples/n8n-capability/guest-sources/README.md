These modules contain frozen guest code for the existing component and Studio compiler revisions. Their string values are part of persisted Program source and native workflow identities. They intentionally preserve the bytes from the original native ESM functions, including whitespace and comments.

Do not regenerate these artifacts when editing a host helper. A guest behavior change needs a new artifact and a new component/compiler revision; keep old artifacts available for source readback. The host validators can evolve independently, but their behavior must remain compatible with each supported guest revision.

`guest-sources.test.mjs` checks historical source and native expression fingerprints, and proves host function serialization cannot affect them. The signed-runtime Studio test imports the compiler through Vite directly and executes the generated Program in WASM.
