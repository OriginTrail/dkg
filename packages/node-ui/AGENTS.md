# Node UI

Read [DESIGN.md](DESIGN.md) before changing UI code. It explains the tokens, components and rules, and how to change them.

- Use the tokens in `src/ui/styles/00-theme.css` and the components in `src/ui/components/ds/`. No hard-coded colours, corner sizes or fractional type sizes.
- Add anything reusable to `components/ds/`, not to one page.
- Text people read follows the Writing rules in `DESIGN.md`.
- Update `DESIGN.md` in the same PR when a rule, token or component changes.
- Run `pnpm --filter @origintrail-official/dkg-node-ui test` before finishing. `test/design-tokens.test.ts`, `test/class-has-css.test.ts`, `test/design-docs.test.ts` and `test/writing-rules.test.ts` enforce what can be checked.
