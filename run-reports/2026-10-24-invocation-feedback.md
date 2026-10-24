# Visible invocation feedback and older component inputs

The user's screenshot selected the retired HTTP KA
`urn:demo:n8n:component:http-request:e360cc6e6621` in a restored draft.
Its version-one input validator rejects the entered external Open-Meteo URL
before any native execution. Previously the rejection appeared above the
canvas, away from the inspector's unchanged Invoke button.

The inspector now disables new invocations of retired blocks, explains the
required explicit upgrade and preserves the entered URL/method/body while
adding current query/header defaults. A selected block shows progress,
validation/transport errors and the result beside its action, with scrolling
to bring feedback into view. Unconfirmed requests retain their invocation ID
and expose the same-request retry locally. Recovery retains the originating
block ID for newly stored requests.

The bridge gives invalid inputs on a retired component an explicit confirmed
upgrade error without dispatching a tool. Valid older requests still reach
their original operation, preserving reconciliation of earlier executions.
Saved workflow pins are not silently changed.

The development snapshot was replaced at the existing Cloudflare origin and
the current source is served on localhost port 4620. Both page HEAD requests
returned HTTP 200. The backend restarted with 36 capability records,
30 current components and 29 current configured bindings. Native templates,
Google credentials and chain configuration did not change in this fix.

The in-memory bridge regression covers rejection before dispatch and keeps
valid older requests eligible for reconciliation. UI regression checks cover
URL preservation across an explicit upgrade and local retired/progress/error/
unconfirmed/completed feedback. No authenticated live gateway or browser
automation was used under the existing tool restrictions.
