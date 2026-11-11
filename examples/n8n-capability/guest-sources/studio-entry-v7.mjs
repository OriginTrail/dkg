// Frozen guest bytes: do not regenerate from host helpers.
export const normalizeBoundEntrySource = [
  "function normalizeBoundEntry(root, inputs, args, descriptor, input, normalize, resolveParams) {",
  "  // Validate raw JSON structure/budgets first, before applying the entry's semantic contract.",
  "  const value = normalize({ ...descriptor, id: 'studio-entry', input: 'items' }, input);",
  "  const bindings = { ...root.inputValues };",
  "  for (const argument of inputs)",
  "    for (const target of argument.targets)",
  "      if (target.kind === 'input' && target.nodeId === root.id)",
  "        bindings[target.parameter] = args[argument.name];",
  "  const rows = JSON.parse(value.itemsJson).map(row => ({ ...row, ...bindings }));",
  "  normalize(descriptor, { ...value, itemsJson: JSON.stringify(rows),",
  "    paramsJson: JSON.stringify(resolveParams(root.params, inputs, root.id, args)) });",
  "  return value;",
  "}",
].join('\n');
