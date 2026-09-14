import { resolveVmResourceEnvironment } from './resource-limits.js';

/** VM-owned process snapshot. Sync catch-up owns a separate runtime module. */
export const VM_RESOURCE_ENV = resolveVmResourceEnvironment(process.env);
