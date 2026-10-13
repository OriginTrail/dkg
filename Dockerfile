# Container image of the DKG node, built from this repository's source with the
# repository's own install and runtime build, so an image holds the code of the
# commit it was built from.
#
# Build from the repository root (both arguments are optional for a local
# build; they label the image and record the commit in /api/status):
#
#   docker build \
#     --build-arg DKG_VERSION="$(node -p "require('./package.json').version")" \
#     --build-arg DKG_COMMIT="$(git rev-parse HEAD)" \
#     -t dkg-node .
#
# Running a node from the image: docs/use-dkg/run-node.md. Release images are
# published to ghcr.io/origintrail/dkg-node by .github/workflows/node-image.yml.

# Node.js 22 (.nvmrc) on Debian slim. The node's Oxigraph server binary, which
# it downloads on first start, needs glibc.
FROM node:22.23.3-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS build

# A compiler for a native module that has no prebuilt binary for the platform
# (better-sqlite3 then builds with node-gyp). It stays in this stage.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
# pnpm at the version in package.json#packageManager.
RUN corepack enable pnpm

COPY . .

# A release build checks that every package.json carries the release version.
ARG DKG_VERSION=""
RUN if [ -n "$DKG_VERSION" ]; then \
      node scripts/release-packages.mjs verify-versions --version "$DKG_VERSION"; \
    fi

# The install and runtime build of a node installed from source.
RUN pnpm install --frozen-lockfile \
    && pnpm run build:runtime

# Build metadata that /api/status and the startup log report.
ARG DKG_COMMIT=""
RUN if [ -n "$DKG_COMMIT" ]; then \
      node scripts/release-packages.mjs build-info --dist-tag container --commit "$DKG_COMMIT"; \
    fi

# Keep only the production dependencies of the packages build:runtime builds
# (its runtime build plan). That leaves out development tools and the Solidity
# toolchain, which a node never runs.
# hadolint ignore=SC2086
RUN find . -name node_modules -type d -prune -exec rm -rf {} + \
    && filters="$(node --input-type=module -e 'import { runtimeBuildFilterArgs } from "./scripts/lib/runtime-build-plan.mjs"; console.log(runtimeBuildFilterArgs().join(" "))')" \
    && pnpm install --prod --frozen-lockfile --offline $filters \
    && chmod 0755 packages/cli/dist/cli.js scripts/docker-entrypoint.sh


FROM node:22.23.3-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa

# tini runs as PID 1: it passes stop signals on to the node and reaps the
# child processes the node leaves behind.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /app/packages/cli/dist/cli.js /usr/local/bin/dkg \
    && mkdir /data \
    && chown node:node /data

COPY --from=build /app /app

ARG DKG_VERSION=""
ARG DKG_COMMIT=""
LABEL org.opencontainers.image.title="DKG node" \
      org.opencontainers.image.description="OriginTrail Decentralized Knowledge Graph (DKG) V10 node" \
      org.opencontainers.image.source="https://github.com/OriginTrail/dkg" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${DKG_VERSION}" \
      org.opencontainers.image.revision="${DKG_COMMIT}"

# The node keeps all of its state (config, keys, auth token, store, logs) in
# DKG_HOME. DKG_NO_BLUE_GREEN runs the code of this image, never a release
# slot that an earlier install left in the volume.
ENV DKG_HOME=/data \
    DKG_NO_BLUE_GREEN=1
VOLUME ["/data"]
WORKDIR /data
USER node

# The API and Node UI, and the peer-to-peer (libp2p TCP) port.
EXPOSE 9200/tcp 9090/tcp

# GET and HEAD /api/status need no token; HEAD only checks that the API answers.
HEALTHCHECK --interval=30s --timeout=10s --start-period=2m --retries=3 \
  CMD node -e 'const fs = require("node:fs"); let port = 9200; try { port = Number(fs.readFileSync(`${process.env.DKG_HOME}/api.port`, "utf8")) || port; } catch {} fetch(`http://127.0.0.1:${port}/api/status`, { method: "HEAD" }).then((res) => process.exit(res.ok ? 0 : 1), () => process.exit(1));'

ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/docker-entrypoint.sh"]
CMD ["start", "--foreground"]
