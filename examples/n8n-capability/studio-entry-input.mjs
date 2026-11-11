/** Compiler 7 validates effective entry rows, retaining the unbound invocation envelope.
 * This pure helper is embedded verbatim in the Program and called by host admission.
 * The native per-node guard still performs the actual binding exactly once.
 */
export function normalizeBoundEntry(root, inputs, args, descriptor, input, normalize, resolveParams) {
  // Validate raw JSON structure/budgets first, before applying the entry's semantic contract.
  const value = normalize({ ...descriptor, id: 'studio-entry', input: 'items' }, input);
  const bindings = { ...root.inputValues };
  for (const argument of inputs)
    for (const target of argument.targets)
      if (target.kind === 'input' && target.nodeId === root.id)
        bindings[target.parameter] = args[argument.name];
  const rows = JSON.parse(value.itemsJson).map(row => ({ ...row, ...bindings }));
  normalize(descriptor, { ...value, itemsJson: JSON.stringify(rows),
    paramsJson: JSON.stringify(resolveParams(root.params, inputs, root.id, args)) });
  return value;
}

export function hasEntryInputBindings(definition) {
  return definition.nodes.some(node => node.id === definition.entryId && node.inputValues !== undefined)
    || definition.inputs?.some(input => input.targets.some(target => target.kind === 'input' && target.nodeId === definition.entryId));
}
