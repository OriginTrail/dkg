// SPDX-License-Identifier: Apache-2.0

/**
 * Deployed-bytecode feature probe shared by the adapter's "does this contract
 * have function X" checks (the DKGKnowledgeAssets `getMaxKaNumberForAuthor`
 * high-water view, and `Profile.updateNodeId`).
 */

/**
 * True iff `selector` appears as a `PUSH4 <selector>` dispatcher entry in the
 * deployed runtime bytecode `code`. A Solidity function dispatcher compares
 * `msg.sig` against each external selector via `PUSH4 <selector>` (opcode
 * `0x63`), so this matches `63<selector>` rather than the bare 4 selector
 * bytes: a plain substring match would false-POSITIVE on the same 4 bytes
 * appearing inside an unrelated constant or the metadata blob. Absence of the
 * PUSH4 entry reliably signals the function is not deployed — for a DIRECT
 * deployment. Behind a proxy the implementation's selectors would not appear
 * in the proxy bytecode, so proxying a probed contract MUST revisit this.
 * A `selector` that is not `0x` + 4 bytes of hex never matches.
 */
export function selectorInDeployedCode(code: string, selector: string): boolean {
  if (!/^0x[0-9a-fA-F]{8}$/.test(selector)) return false;
  return code.toLowerCase().includes(`63${selector.toLowerCase().slice(2)}`);
}
