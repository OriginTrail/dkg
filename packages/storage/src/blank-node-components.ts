/** True when an N-Quads term string denotes an RDF blank node (`_:label`). */
export function isBlankNodeTerm(term: string | undefined): term is string {
  return typeof term === 'string' && term.startsWith('_:');
}

export interface ConnectedBlankNodeComponent<T> {
  items: T[];
  blankNodeLabels: Set<string>;
  firstIndex: number;
}

/**
 * Partition RDF-shaped items into stable, transitively connected blank-node
 * components. Items without blank nodes remain independent singleton units.
 *
 * Callers choose which terms share one blank-node scope. For example, a
 * graph-local SPARQL operation can pass subject/object after grouping by
 * graph, while an N-Quads insert operation can also include the graph term.
 */
export function partitionConnectedBlankNodeComponents<T>(
  items: readonly T[],
  termsForItem: (item: T) => readonly (string | undefined)[],
): ConnectedBlankNodeComponent<T>[] {
  const parents = items.map((_, index) => index);
  const ranks = items.map(() => 0);
  const labelsByItem = items.map((item) => new Set(termsForItem(item).filter(isBlankNodeTerm)));
  const firstItemByLabel = new Map<string, number>();

  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root]!;
    while (parents[index] !== index) {
      const next = parents[index]!;
      parents[index] = root;
      index = next;
    }
    return root;
  };

  const union = (left: number, right: number): void => {
    let leftRoot = find(left);
    let rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (ranks[leftRoot]! < ranks[rightRoot]!) [leftRoot, rightRoot] = [rightRoot, leftRoot];
    parents[rightRoot] = leftRoot;
    if (ranks[leftRoot] === ranks[rightRoot]) ranks[leftRoot]! += 1;
  };

  for (let index = 0; index < items.length; index += 1) {
    for (const label of labelsByItem[index]!) {
      const firstIndex = firstItemByLabel.get(label);
      if (firstIndex === undefined) firstItemByLabel.set(label, index);
      else union(index, firstIndex);
    }
  }

  const components = new Map<number, ConnectedBlankNodeComponent<T>>();
  for (let index = 0; index < items.length; index += 1) {
    const labels = labelsByItem[index]!;
    const root = labels.size === 0 ? index : find(index);
    let component = components.get(root);
    if (!component) {
      component = { items: [], blankNodeLabels: new Set(), firstIndex: index };
      components.set(root, component);
    }
    component.items.push(items[index]!);
    for (const label of labels) component.blankNodeLabels.add(label);
  }

  return [...components.values()].sort((left, right) => left.firstIndex - right.firstIndex);
}
