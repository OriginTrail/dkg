# SDK Examples

- `quickstart.ts` — minimal node/paranet connectivity check
- `publish-query-flow.ts` — publish data then query it
- `auth.ts` — token auth, custom headers, and error handling

Set optional env vars:

- `DKG_BASE_URL` (default: `http://127.0.0.1:9200`)
- `DKG_TOKEN`
- `DKG_PARANET_ID` (used by `publish-query-flow.ts`)

Run from repository root with your preferred TS runner (for example `tsx`):

```bash
tsx packages/sdk/examples/quickstart.ts
tsx packages/sdk/examples/publish-query-flow.ts
tsx packages/sdk/examples/auth.ts
```
