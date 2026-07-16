export const MEMORY_LABEL_PREDICATES = [
  'http://schema.org/name',
  'http://www.w3.org/2000/01/rdf-schema#label',
  'http://purl.org/dc/terms/title',
  'http://purl.org/dc/elements/1.1/title',
  'http://xmlns.com/foaf/0.1/name',
] as const;

export function memoryGraphLabels(opts: {
  minZoomForLabels?: number;
  extraPredicates?: readonly string[];
} = {}) {
  const labels: { predicates: string[]; minZoomForLabels?: number } = {
    predicates: [...(opts.extraPredicates ?? []), ...MEMORY_LABEL_PREDICATES],
  };
  if (opts.minZoomForLabels !== undefined) {
    labels.minZoomForLabels = opts.minZoomForLabels;
  }
  return labels;
}
