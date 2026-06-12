---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Daemon Lifecycle

Common commands:

```bash
dkg start
dkg start -f
dkg stop
dkg status
dkg logs
dkg auth show
dkg auth rotate
```

The daemon API defaults to:

```text
http://127.0.0.1:9200
```

The Node UI defaults to:

```text
http://127.0.0.1:9200/ui
```

If an agent gets auth errors, first identify the caller:

```bash
TOKEN=$(dkg auth show)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9200/api/agent/identity
```
