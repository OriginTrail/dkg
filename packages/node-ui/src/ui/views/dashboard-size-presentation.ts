/** Resolve the dashboard's live, preview and summary units together. */
export function dashboardSizePresentation(size: {
  entities: { total: number };
  triples: { total: number };
  sizePartial: boolean;
  sizeApprox: boolean;
  triplesUnknown: boolean;
}) {
  const loaded = size.sizePartial && !size.sizeApprox;
  const prefix = size.sizeApprox && !size.triplesUnknown ? '~' : '';
  const suffix = loaded ? '+' : '';
  const entityLabel = size.triplesUnknown ? 'Knowledge Assets (summary)'
    : size.sizeApprox ? 'entities / KA · approx.'
    : loaded ? 'entities loaded' : 'entities / Knowledge Assets';
  const entityTitle = size.triplesUnknown
    ? 'Live entity count unavailable — showing the published Knowledge-Asset summary (not the full WM/SWM/VM entity total)'
    : size.sizeApprox
      ? 'Some context graphs reported only their Knowledge-Asset summary — this total mixes summary and live counts and is approximate'
      : undefined;
  return {
    entityValue: `${prefix}${size.entities.total.toLocaleString()}${suffix}`,
    entityLabel,
    entityTitle,
    tripleValue: size.triplesUnknown ? '—'
      : `${prefix}${size.triples.total.toLocaleString()}${suffix}`,
    tripleLabel: loaded ? 'triples loaded' : 'triples',
    showLayerBars: !size.triplesUnknown && !size.sizeApprox,
  };
}
