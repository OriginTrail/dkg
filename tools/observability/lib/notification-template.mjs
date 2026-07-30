// Human-first Slack notification contract for DKG Grafana alerts.
//
// Keep the operational facts on rule annotations (rather than burying them in
// this template) so they are visible in Grafana state/history as well as Slack.
// The contact-point title intentionally renders empty: Grafana 11.4 builds the
// Slack title link from server.root_url, and the current instance advertises
// localhost. The visible title is therefore rendered in the body together with
// an alert-specific panel link whose time window follows the incident.

export const DKG_NOTIFICATION_TEMPLATE_NAME = 'dkg-readable';
export const GRAFANA_PUBLIC_URL = 'http://100.81.85.62:3000';

export const DKG_NOTIFICATION_TEMPLATE = String.raw`{{ define "dkg.title" }}{{ end }}
{{ define "dkg.incident_link" -}}
{{- $from := .StartsAt.Add -3600000000000 -}}
<{{ reReplaceAll "^https?://localhost:3000" "${GRAFANA_PUBLIC_URL}" .PanelURL }}&from={{ $from.UnixMilli }}&to={{ if eq .Status "resolved" }}{{ .EndsAt.UnixMilli }}{{ else }}now{{ end }}{{ with .Annotations.incident_node_label }}&var-node={{ index $.Labels . | urlquery }}{{ end }}{{ with .Annotations.incident_level }}&var-level={{ . | urlquery }}{{ end }}{{ with .Annotations.incident_search }}&var-search={{ . | urlquery }}{{ end }}|Open exact incident>
{{- end }}
{{ define "dkg.body" -}}
{{- if .Alerts.Firing -}}
🚨 *{{ len .Alerts.Firing }} active DKG {{ if eq (len .Alerts.Firing) 1 }}incident{{ else }}incidents{{ end }}*
{{- range .Alerts.Firing }}
{{ if eq .Labels.priority "P1" }}🔴{{ else if eq .Labels.priority "P2" }}🟠{{ else if eq .Labels.priority "P3" }}🟡{{ else }}🔵{{ end }} *[{{ if eq .Labels.priority "P1" }}P1 — CRITICAL{{ else if eq .Labels.priority "P2" }}P2 — ACTION{{ else if eq .Labels.priority "P3" }}P3 — WATCH{{ else }}TEST{{ end }}] {{ with .Annotations.slack_title }}{{ . }}{{ else }}{{ .Labels.alertname }}{{ end }}*
{{ with index .Labels "deployment_environment" }}*Environment:* {{ . }}
{{ end }}{{ with .Annotations.what_happened }}*What happened:* {{ . }}
{{ end }}{{ with .Annotations.affected }}*Affected:* {{ . }}
{{ end }}{{ with .Annotations.react }}*React:* {{ . }}
{{ end }}{{ with .Annotations.check_first }}*Check first:* {{ . }}
{{ end }}{{ with .Annotations.evidence }}*Evidence:* {{ . }}
{{ end }}*Link:* {{ template "dkg.incident_link" . }}
{{- end -}}
{{- end -}}
{{- if .Alerts.Resolved -}}
✅ *{{ len .Alerts.Resolved }} recovered DKG {{ if eq (len .Alerts.Resolved) 1 }}incident{{ else }}incidents{{ end }}*
{{- range .Alerts.Resolved }}
*[RECOVERED][{{ with .Labels.priority }}{{ . }}{{ else }}DKG{{ end }}] {{ with .Annotations.slack_title }}{{ . }}{{ else }}{{ .Labels.alertname }}{{ end }}*
The alert is no longer firing. No immediate action is required.
*Link:* {{ template "dkg.incident_link" . }}
{{- end -}}
{{- end -}}
{{- end }}`;

const priorityLabel = {
  P1: { icon: '🔴', text: 'P1 — CRITICAL' },
  P2: { icon: '🟠', text: 'P2 — ACTION' },
  P3: { icon: '🟡', text: 'P3 — WATCH' },
};

/**
 * Deterministic local preview used by CI. Grafana remains the authoritative Go
 * template renderer; this proves that every spec supplies the human contract
 * and gives reviewers concrete firing/recovery messages without Slack access.
 */
const exactIncidentUrl = ({
  status,
  labels,
  annotations,
  panelUrl,
  startsAt = 1720000000000,
  endsAt = 1720000900000,
}) => {
  const url = new URL(
    panelUrl.replace(/^https?:\/\/localhost:3000/, GRAFANA_PUBLIC_URL),
  );
  url.searchParams.set('from', String(startsAt - 3600000));
  url.searchParams.set('to', status === 'resolved' ? String(endsAt) : 'now');
  if (annotations.incident_node_label) {
    url.searchParams.set(
      'var-node',
      labels[annotations.incident_node_label] ?? '',
    );
  }
  if (annotations.incident_level) {
    url.searchParams.set('var-level', annotations.incident_level);
  }
  if (annotations.incident_search) {
    url.searchParams.set('var-search', annotations.incident_search);
  }
  return url.toString();
};

const renderAlertPreview = ({
  status,
  labels,
  annotations,
  panelUrl,
  startsAt,
  endsAt,
}) => {
  const priority = labels.priority ?? 'TEST';
  const display = priorityLabel[priority] ?? { icon: '🔵', text: 'TEST' };
  const title = annotations.slack_title || labels.alertname || 'DKG alert';
  const link = `<${exactIncidentUrl({
    status,
    labels,
    annotations,
    panelUrl,
    startsAt,
    endsAt,
  })}|Open exact incident>`;

  if (status === 'resolved') {
    return [
      `*[RECOVERED][${priority}] ${title}*`,
      'The alert is no longer firing. No immediate action is required.',
      `*Link:* ${link}`,
    ].join('\n');
  }

  return [
    `${display.icon} *[${display.text}] ${title}*`,
    labels.deployment_environment && `*Environment:* ${labels.deployment_environment}`,
    annotations.what_happened && `*What happened:* ${annotations.what_happened}`,
    annotations.affected && `*Affected:* ${annotations.affected}`,
    annotations.react && `*React:* ${annotations.react}`,
    annotations.check_first && `*Check first:* ${annotations.check_first}`,
    annotations.evidence && `*Evidence:* ${annotations.evidence}`,
    `*Link:* ${link}`,
  ].filter(Boolean).join('\n');
};

export function renderSlackGroupPreview({ firing = [], resolved = [] }) {
  const sections = [];
  if (firing.length) {
    sections.push(
      `🚨 *${firing.length} active DKG ${firing.length === 1 ? 'incident' : 'incidents'}*`,
      ...firing.map((alert) =>
        renderAlertPreview({ ...alert, status: 'firing' })),
    );
  }
  if (resolved.length) {
    sections.push(
      `✅ *${resolved.length} recovered DKG ${resolved.length === 1 ? 'incident' : 'incidents'}*`,
      ...resolved.map((alert) =>
        renderAlertPreview({ ...alert, status: 'resolved' })),
    );
  }
  return sections.join('\n');
}

export function renderSlackPreview(alert) {
  return renderSlackGroupPreview({
    [alert.status === 'resolved' ? 'resolved' : 'firing']: [alert],
  });
}
