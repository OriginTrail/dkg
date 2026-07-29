// Human-first Slack notification contract for DKG Grafana alerts.
//
// Keep the operational facts on rule annotations (rather than burying them in
// this template) so they are visible in Grafana state/history as well as Slack.
// The contact-point title intentionally renders empty: Grafana 11.4 builds the
// Slack title link from server.root_url, and the current instance advertises
// localhost. The visible title is therefore rendered in the body together with
// explicit, working dashboard/runbook links.

export const DKG_NOTIFICATION_TEMPLATE_NAME = 'dkg-readable';

export const DKG_NOTIFICATION_TEMPLATE = String.raw`{{ define "dkg.title" }}{{ end }}
{{ define "dkg.body" -}}
{{- if .Alerts.Firing -}}
{{- range .Alerts.Firing }}
{{ if eq .Labels.priority "P1" }}🔴{{ else if eq .Labels.priority "P2" }}🟠{{ else if eq .Labels.priority "P3" }}🟡{{ else }}🔵{{ end }} *[{{ if eq .Labels.priority "P1" }}P1 — CRITICAL{{ else if eq .Labels.priority "P2" }}P2 — ACTION{{ else if eq .Labels.priority "P3" }}P3 — WATCH{{ else }}TEST{{ end }}] {{ with .Annotations.slack_title }}{{ . }}{{ else }}{{ .Labels.alertname }}{{ end }}*
{{ with index .Labels "deployment_environment" }}*Environment:* {{ . }}
{{ end }}{{ with .Annotations.what_happened }}*What happened:* {{ . }}
{{ end }}{{ with .Annotations.affected }}*Affected:* {{ . }}
{{ end }}{{ with .Annotations.react }}*React:* {{ . }}
{{ end }}{{ with .Annotations.check_first }}*Check first:* {{ . }}
{{ end }}{{ with .Annotations.evidence }}*Evidence:* {{ . }}
{{ end }}{{ if or .Annotations.dashboard_url .Annotations.logs_url .Annotations.runbook_url }}*Links:*{{ with .Annotations.dashboard_url }} <{{ . }}|Open dashboard>{{ end }}{{ with .Annotations.logs_url }} · <{{ . }}|Open logs>{{ end }}{{ with .Annotations.runbook_url }} · <{{ . }}|Runbook>{{ end }}
{{ end }}
{{- end -}}
{{- end -}}
{{- if .Alerts.Resolved -}}
{{- range .Alerts.Resolved }}
✅ *[RECOVERED][{{ with .Labels.priority }}{{ . }}{{ else }}DKG{{ end }}] {{ with .Annotations.slack_title }}{{ . }}{{ else }}{{ .Labels.alertname }}{{ end }}*
The alert is no longer firing. The issue lasted {{ .EndsAt.Sub .StartsAt }}. No immediate action is required.
{{ if or .Annotations.dashboard_url .Annotations.logs_url .Annotations.runbook_url }}*Links:*{{ with .Annotations.dashboard_url }} <{{ . }}|Open dashboard>{{ end }}{{ with .Annotations.logs_url }} · <{{ . }}|Open logs>{{ end }}{{ with .Annotations.runbook_url }} · <{{ . }}|Runbook>{{ end }}
{{ end }}
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
export function renderSlackPreview({ status, labels, annotations, duration = '18m0s' }) {
  const priority = labels.priority ?? 'TEST';
  const display = priorityLabel[priority] ?? { icon: '🔵', text: 'TEST' };
  const title = annotations.slack_title || labels.alertname || 'DKG alert';
  const links = [
    annotations.dashboard_url && `<${annotations.dashboard_url}|Open dashboard>`,
    annotations.logs_url && `<${annotations.logs_url}|Open logs>`,
    annotations.runbook_url && `<${annotations.runbook_url}|Runbook>`,
  ].filter(Boolean).join(' · ');

  if (status === 'resolved') {
    return [
      `✅ *[RECOVERED][${priority}] ${title}*`,
      `The alert is no longer firing. The issue lasted ${duration}. No immediate action is required.`,
      links && `*Links:* ${links}`,
    ].filter(Boolean).join('\n');
  }

  return [
    `${display.icon} *[${display.text}] ${title}*`,
    labels.deployment_environment && `*Environment:* ${labels.deployment_environment}`,
    annotations.what_happened && `*What happened:* ${annotations.what_happened}`,
    annotations.affected && `*Affected:* ${annotations.affected}`,
    annotations.react && `*React:* ${annotations.react}`,
    annotations.check_first && `*Check first:* ${annotations.check_first}`,
    annotations.evidence && `*Evidence:* ${annotations.evidence}`,
    links && `*Links:* ${links}`,
  ].filter(Boolean).join('\n');
}
