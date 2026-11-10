import profile from '../profiles/jpb.mjs';
import { createStudioContext } from '../studio-context.mjs';
export const context = createStudioContext({ profile });
export const { compiler, registry } = context;
export { profile };
