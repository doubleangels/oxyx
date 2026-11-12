# syntax=docker/dockerfile:1
#
# Panel image, linux/amd64. The panel drives the HOST's Docker daemon and
# creates Minecraft servers as SIBLING containers: run it with the Docker socket
# (or a socket proxy, see deploy/docker-compose.socket-proxy.yml) and
# DATA_DIR_HOST set to the host path of the /data mount (see docker-compose.yml).
#
# Two stages:
#   build    Node + pnpm on Alpine. Installs every dependency, builds the CSS
#            and client-JS bundles, then resolves the production dependency
#            tree on its own and prunes data the panel never reads.
#   runtime  Bare Alpine plus the Node binary copied from the build stage and
#            the two shared libraries it links (libstdc++, libgcc). No npm,
#            corepack, yarn or pnpm, no build tools, no sources the panel does
#            not load at run time.
#
# Base images are pinned by version AND digest in the FROM lines, where
# Dependabot (docker ecosystem) can propose bumps. The two must share an Alpine
# release (3.24 here) so the copied node binary finds the musl and libstdc++ it
# was built against; test/compose-pin.test.js enforces that.

# ---------------------------------------------------------------------------
FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /app
ARG PNPM_VERSION=11.25.0
# The install-time postinstall hook (a CSS build) is skipped; `pnpm run build`
# below builds CSS and JS explicitly, after the sources are copied.
ENV MSM_SKIP_POSTINSTALL=1
# Pin pnpm directly instead of corepack (deprecated, being removed from Node).
RUN npm install -g pnpm@${PNPM_VERSION}

# Dependency layers key on the lockfile alone: `pnpm fetch` fills the store from
# pnpm-lock.yaml without reading package.json, so a script or version edit that
# leaves the lockfile alone re-downloads nothing.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm fetch
COPY package.json ./
COPY scripts/postinstall.js ./scripts/postinstall.js
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --offline

# Production dependencies, resolved on their own from the same store (offline)
# and pruned, before the sources arrive: a source edit does not redo this. The
# cache mount is a separate filesystem, so pnpm copies rather than hard-links
# and /prod/node_modules is self-contained.
COPY scripts/prune-prod-deps.js ./scripts/prune-prod-deps.js
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    mkdir /prod && cp package.json pnpm-lock.yaml pnpm-workspace.yaml /prod/ && \
    cd /prod && pnpm install --frozen-lockfile --prod --offline --ignore-scripts && \
    node /app/scripts/prune-prod-deps.js /prod/node_modules

# Style + client-JS build. assets/css/input.css scans src/, views/ and
# public/js for class names, so all three are inputs here.
COPY assets ./assets
COPY views ./views
COPY public ./public
COPY scripts/build-js.js ./scripts/build-js.js
COPY src ./src
RUN pnpm run build

# ---------------------------------------------------------------------------
FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS runtime
ARG VERSION=dev
LABEL org.opencontainers.image.title="Oxyx" \
      org.opencontainers.image.description="Control panel for Minecraft servers running in Docker." \
      org.opencontainers.image.source="https://github.com/doubleangels/oxyx" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

# libstdc++ (pulls libgcc) is all the Node binary links beyond musl. tini runs
# as PID 1: it forwards SIGTERM to Node, so `docker stop` triggers the panel's
# graceful shutdown even without compose's `init: true`, and reaps zombies.
RUN apk add --no-cache libstdc++ tini
COPY --from=build /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
# LOG_PRETTY=false: newline-delimited JSON on stdout for the container runtime.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PANEL_HOST=0.0.0.0 \
    PANEL_PORT=25564 \
    LOG_PRETTY=false

# Least-volatile first, so a source-only change re-copies as little as possible.
COPY package.json ./
COPY --from=build /prod/node_modules ./node_modules
COPY --from=build /app/public ./public
COPY views ./views
COPY src ./src

EXPOSE 25564
VOLUME /data
# Runs as root: the mounted Docker socket needs it (the host's docker-group GID
# is unknowable at build time), and a socket-holding container is already
# root-equivalent on the host, so dropping privileges here would only pretend.
# /healthz is unauthenticated, checks the DB, and returns 503 on failure.
# busybox wget is part of the Alpine base.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PANEL_PORT}/healthz" || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
