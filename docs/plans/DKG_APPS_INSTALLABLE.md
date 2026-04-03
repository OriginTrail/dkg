# Installable DKG Apps — No edits to core packages

**Status**: Implemented  
**Goal:** Anyone can build an app (e.g. a game) in **their own repo**, publish it (npm, GitHub), and **node runners** can install it so the app appears in the Node UI and its API is served by the daemon — **without changing `packages/cli` or `packages/node-ui`** (or any other core package). No maintainer approval required for new apps.

> **Implementation note (2026-03):** The app loader system is implemented in `packages/cli/src/app-loader.ts`. The daemon discovers app packages via the `dkgApp` manifest field, loads API handlers, and serves static UI. The `GET /api/apps` endpoint returns installed apps for the Node UI sidebar. The OriginTrail game (`packages/origin-trail-game`) is the reference installable app and ships as a default dependency.

---

## 1) Contract: what an “installable app” is

An **installable DKG app** is a package that:

1. **Lives in its own repo** (or is published to npm). Node runners install it (e.g. `pnpm add dkg-app-oregon-trail` or install from a path/GitHub).
2. **Declares itself** via a well-known **manifest** (e.g. `package.json` field `dkgApp`, or a `dkg-app.json` in the package).
3. **Backend:** Exports an **API handler** the daemon can load and run for requests under a path (e.g. `/api/apps/oregon-trail/*`).
4. **Frontend:** Ships a **built UI** (static assets: HTML + JS + CSS) that the daemon can serve at a path (e.g. `/apps/oregon-trail/`).

The **core repo** adds **one-time** support:

- **Daemon:** Discovers installed app packages (from config or convention), loads their API handlers, serves their static UI. No per-app code in `packages/cli`.
- **Node UI:** Has a **generic** “installed apps” feature: it asks the daemon for the list of apps and shows them in the sidebar; clicking an app opens it (same tab or iframe at `/apps/:appId/`). No per-app code in `packages/node-ui`.

After that, adding a new app never requires editing the core repo — only installing the app package and (if needed) adding it to the node’s app config.

---

## 2) App package layout (author’s repo)

An app author creates a package that looks like this:

```
my-dkg-app/
├── package.json          # name, version, "dkgApp": { "id": "my-app", "apiHandler": "./dist/handler.js", "staticDir": "./dist-ui" }
├── src/
│   ├── handler.ts        # API handler (see below)
│   └── ...
├── ui/                   # Optional: React/Vite app for the app’s UI
│   ├── index.html
│   ├── src/
│   └── vite.config.ts    # build to dist-ui
├── dist/                 # Built handler (Node)
├── dist-ui/              # Built static UI (served by daemon)
└── dkg-app.json          # Optional override: id, label, pathPrefix, apiPrefix
```

**Manifest (`package.json` or `dkg-app.json`):**

- `id` — unique app id (e.g. `oregon-trail`). Used in URLs: `/apps/oregon-trail/`, `/api/apps/oregon-trail/*`.
- `label` — display name in sidebar (e.g. `"Oregon Trail"`).
- `apiHandler` — path to the Node handler entry (e.g. `./dist/handler.js`). Must export a single function with a known signature (see below).
- `staticDir` — path to the built UI (e.g. `./dist-ui`). Daemon serves this at `/apps/{id}/`.

**API handler signature:**

The handler is loaded by the daemon (e.g. dynamic `import()` of the app’s `apiHandler` file). It receives the **agent**, **config**, and any **app options** from the node config. It returns a function that the daemon calls for each request:

- `(req, res, url) => Promise<boolean>`: return `true` if the request was handled (e.g. `url.pathname.startsWith('/api/apps/oregon-trail/')`).

So the app owns all routes under `/api/apps/{id}/`. No edits to daemon route table.

**UI:**

- The app builds its UI however it wants (Vite, plain HTML/JS, etc.) into `staticDir`. The daemon serves that directory at `GET /apps/{id}/*` (e.g. `/apps/oregon-trail/` → `index.html`, `/apps/oregon-trail/assets/...`). The app’s UI can call `fetch('/api/apps/oregon-trail/...')`; the daemon will route those to the app’s handler. No CORS issue (same origin as the Node UI host).

---

## 3) Daemon: one-time “app loader”

**No per-app code.** The daemon gains a single generic mechanism:

1. **Discovery:** Read “installed apps” from config (e.g. `config.apps: [{ package: "dkg-app-oregon-trail" }, { package: "some-other-app", options: { ... } }]`) or from a convention (e.g. scan `node_modules` for packages that have a `dkgApp` field in `package.json`).
2. **Load:** For each app, resolve the package (e.g. `require.resolve('dkg-app-oregon-trail/package.json')`), read manifest (`dkgApp` or `dkg-app.json`), then `import(app.apiHandler)`. Call the default export with `(agent, config, appOptions)` to get the request handler. Store handlers in a list.
3. **Serve API:** In the HTTP server, after `handleNodeUIRequest`, run `for (const h of appHandlers) { if (await h(req, res, url)) return; }`. So any request not handled by the core or Node UI can be handled by an app.
4. **Serve UI:** For `GET /apps/:appId/*`, serve static files from the app’s `staticDir` (resolved from the app’s package path). If `appId` is unknown, 404.

Config shape (example):

```json
{
  "apps": [
    { "package": "dkg-app-oregon-trail" },
    { "package": "github:user/cool-game", "options": { "paranetId": "my-paranet" } }
  ]
}
```

Or: if `apps` is omitted, the daemon can optionally scan `node_modules` for packages with `"dkgApp": { ... }` and load those (so “install and restart” is enough).

---

## 4) Node UI: one-time “app host”

**No per-app code.** The Node UI gains a single generic feature:

1. **Fetch app list:** On load, call `GET /api/apps` (or the list is embedded in a shared config the daemon serves with the main UI). Response: `[{ id, label, path: "/apps/oregon-trail" }, ...]`.
2. **Sidebar:** In addition to the built-in nav items (Dashboard, Network, …), render an “Apps” section (or a single “Apps” submenu) that lists these entries. Each link goes to `{path}` (e.g. `/apps/oregon-trail/`).
3. **Opening an app:** When the user clicks an app, navigate to `/apps/oregon-trail/`. That URL is **served by the daemon** (static files from the app’s `staticDir`). So the browser loads the app’s `index.html` and its JS/CSS. The app’s UI runs in the same origin as the Node UI (same host/port), so it can call `fetch('/api/apps/oregon-trail/...')` without CORS. Optionally, the core UI could embed the app in an iframe with `src="/apps/oregon-trail/"` so the main shell (sidebar, etc.) stays visible; or the app can be full-page (simplest for the app author).

So: **one** new API in the daemon (`GET /api/apps` returns the list of installed apps from discovery/config), **one** new route in the daemon (serve `GET /apps/:appId/*` from app’s `staticDir`), and **one** generic “Apps” section in the Node UI that lists links. No component or route is added for “Oregon Trail” or any other app inside the core Node UI.

---

## 5) Summary: what goes where

| Who | What | Where |
|-----|------|--------|
| **Core (one-time)** | App discovery + loader; serve app API + app static UI; `GET /api/apps` | `packages/cli` (daemon) |
| **Core (one-time)** | Fetch app list, show “Apps” in sidebar, link to `/apps/:id/` | `packages/node-ui` |
| **App author** | Package with manifest, API handler, built UI | Their repo (e.g. `dkg-app-oregon-trail`) |
| **Node runner** | Install app package, add to `config.apps` (if not auto-discovered), restart node | No edits to core |

No one needs to touch `packages/cli` or `packages/node-ui` to add a new game or app — only to add this **one-time** plugin/app mechanism.

---

## 6) Shipping an app with the node by default (still from a separate repo)

You can **ship Oregon Trail (or any app) with the node by default** while keeping it in a **separate repo**. No merge into the core monorepo is required.

People run the node by cloning `dkg-v9`, running `pnpm install` and `pnpm build`, then `pnpm dkg start`. The repo is `private: true` (not published to npm). So "shipping an app by default" just means adding it as a **dependency** in the repo.

**How:**

1. **Publish the app** from its own repo (npm, GitHub Packages, or just a GitHub repo URL), e.g. `dkg-app-oregon-trail`.
2. **Add one line** to `dkg-v9/package.json` (or `packages/cli/package.json`):
   ```json
   "dependencies": {
     "dkg-app-oregon-trail": "github:yourorg/dkg-app-oregon-trail"
   }
   ```
3. **`pnpm install`** pulls it into `node_modules`. The daemon's generic app loader discovers it (because it has a `dkgApp` field in its `package.json`, or because it's listed in the default app config).
4. Users **clone the repo, `pnpm install`, `pnpm build`, `pnpm dkg start`** — Oregon Trail is there in the sidebar. No code in `packages/cli` or `packages/node-ui` was touched; only a dependency line was added.

The app still lives in its own repo, with its own releases and maintainers. `dkg-v9` just depends on it like any other npm dependency.

**Summary:** Default app = same installable app package, added as a dependency of the `dkg-v9` repo. One line in `package.json`, zero code changes in core packages.
