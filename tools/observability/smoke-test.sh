#!/usr/bin/env bash
# Post-deploy smoke test for the DKG log-ingest path.
# Pushes one OTLP log through the public ingest endpoint and confirms it lands
# in Loki, then checks that a tokenless push is rejected. Run on the Loki host.
#
#   INGEST_URL=https://logs-ingest.xtrmstrngth.com/v1/logs \
#   INGEST_TOKEN=<token> \
#   LOKI=http://127.0.0.1:3100 \
#   ./smoke-test.sh
set -euo pipefail
: "${INGEST_URL:?set INGEST_URL, e.g. https://logs-ingest.xtrmstrngth.com/v1/logs}"
: "${INGEST_TOKEN:?set INGEST_TOKEN}"
LOKI="${LOKI:-http://127.0.0.1:3100}"
NODE="smoke-test-$$"
NS=$(( $(date +%s) * 1000000000 ))

payload='{"resourceLogs":[{"resource":{"attributes":[
  {"key":"service.name","value":{"stringValue":"dkg-node"}},
  {"key":"service.instance.id","value":{"stringValue":"'"$NODE"'"}},
  {"key":"deployment.environment","value":{"stringValue":"testnet"}}]},
  "scopeLogs":[{"scope":{"name":"dkg-node"},"logRecords":[
  {"timeUnixNano":"'"$NS"'","severityNumber":9,"severityText":"INFO","body":{"stringValue":"smoke-test ok"}}]}]}]}'

echo "→ pushing test log as $NODE ..."
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INGEST_URL" \
  -H "authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' -d "$payload")
echo "  ingest HTTP $code (expect 2xx)"

sleep 5
echo "→ querying Loki for it ..."
START=$(date -u -v-5M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '5 min ago' +%Y-%m-%dT%H:%M:%SZ)
END=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if curl -s -G "$LOKI/loki/api/v1/query_range" \
     --data-urlencode "query={service_instance_id=\"$NODE\"}" \
     --data-urlencode "start=$START" --data-urlencode "end=$END" | grep -q 'smoke-test ok'; then
  echo "  ✅ PASS — log reached Loki (pick '$NODE' in the dashboard to see it)"
else
  echo "  ❌ FAIL — not found in Loki. Check Alloy logs + Loki push URL."
fi

echo "→ negative check: tokenless push should be rejected ..."
noauth=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INGEST_URL" \
  -H 'content-type: application/json' -d "$payload")
echo "  no-token HTTP $noauth (expect 401/403 from the Cloudflare WAF rule)"
