// Explicit test fixture selection; never enables transport effects.
import { fileURLToPath } from 'node:url';
process.env.NOS_DKG_PROFILE_MODULE = fileURLToPath(new URL('../profiles/jpb.mjs', import.meta.url));
