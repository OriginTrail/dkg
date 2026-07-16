// The Prometheus node-identity profile as an explicit model — the ONE
// boundary where profile-sensitive string construction lives. Everything a
// consumer needs (metrics selector, per-node aggregation, legend, variable
// discovery query, raw label for alert expressions/grouping) is built here;
// dashboards, alerts and docs receive this object and never splice the label
// into strings themselves. A future profile change that needs more than a
// label rename (different selector shape, annotation format, …) extends this
// module only.
export const promNodeProfile = (label) => ({
  /** raw Prometheus label name carrying the node identity (service.instance.id) */
  label,
  /** dashboard $node filter fragment for metric selectors */
  selector: `${label}=~"\${node:regex}"`,
  /** per-node aggregation wrapper */
  by: (inner) => `sum by (${label}) (${inner})`,
  /** per-node series legend */
  legend: `{{${label}}}`,
  /** Grafana variable query enumerating nodes from the metrics datasource */
  labelValuesQuery: `label_values({__name__=~"dkg_.+"}, ${label})`,
});
