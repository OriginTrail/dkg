import type { SemanticProgramBinding, SemanticRuntimeConfig } from '@origintrail-official/dkg-semantic-runtime';
import { programBindingDigest } from './semantic-runtime-program-bindings.js';
import { SemanticProgramError } from './semantic-runtime-types.js';

/** Both guest execution and delegated callbacks require the original caller's
 * complete pinned approval tree, including children that are only declared.
 */
export function assertChildApprovalsAuthorized(binding: SemanticProgramBinding, config: SemanticRuntimeConfig, caller: string): void {
  const visited = new Set<string>();
  const check = (selected: SemanticProgramBinding, ancestors: string[]) => {
    for (const pin of selected.typescript?.children ?? []) {
      const key = `${pin.contextGraphId}\0${pin.operationIri}`;
      if (ancestors.includes(key) || ancestors.length >= 8)
        throw new SemanticProgramError('PROGRAM_COMPOSITION_LIMIT', 'Program grants are cyclic or too deep', 403);
      const child = config.programBindings?.find(item => item.contextGraphId === pin.contextGraphId && item.operationIri === pin.operationIri);
      if (!child?.enabled || programBindingDigest(child) !== pin.bindingDigest
        || !child.allowedCallerAgentAddresses.some(address => address.toLowerCase() === caller.toLowerCase()))
        throw new SemanticProgramError('PROGRAM_CHILD_FORBIDDEN', 'A child grant changed or does not authorize the original caller', 403);
      if (!visited.has(key)) { visited.add(key); check(child, [...ancestors, key]); }
    }
  };
  check(binding, [`${binding.contextGraphId}\0${binding.operationIri}`]);
}
