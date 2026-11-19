# Node UI

Read [DESIGN.md](DESIGN.md) before changing UI code. It explains the tokens, components and rules, and how to change them.

- Use the tokens in `src/ui/styles/00-theme.css` and the components in `src/ui/components/ds/`. No hard-coded colours, corner sizes or fractional type sizes.
- Add anything reusable to `components/ds/`, not to one page.
- Text people read follows the Writing rules in `DESIGN.md`.
- Update `DESIGN.md` in the same PR when a rule, token or component changes.
- Run `pnpm --filter @origintrail-official/dkg-node-ui design:check --changed` on UI changes, and `design:check <file>` on a mock-up before building it. For each value off the system, use the token it suggests or, if the design really needs something new, add the token or component as DESIGN.md · Adding to the system says.
- Run `pnpm --filter @origintrail-official/dkg-node-ui test` before finishing. `test/design-tokens.test.ts`, `test/class-has-css.test.ts`, `test/design-docs.test.ts`, `test/design-check.test.ts` and `test/writing-rules.test.ts` enforce what can be checked.
