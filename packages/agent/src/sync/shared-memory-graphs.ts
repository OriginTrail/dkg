export function isSharedMemoryBucketDescendantDataGraph(graph: string, bucketGraph: string): boolean {
  if (!graph.startsWith(`${bucketGraph}/`)) return false;
  const tail = graph.slice(bucketGraph.length + 1);
  if (tail.startsWith('staging/')) return false;
  const parts = tail.split('/');
  return parts.length === 2 && parts[0].length > 0 && /^[0-9]+$/.test(parts[1]);
}
