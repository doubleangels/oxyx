# Panel image. The panel drives the HOST's Docker daemon and creates Minecraft
# servers as SIBLING containers - run it with the Docker socket mounted and
# DATA_DIR_HOST set to the host path of the /data mount (see docker-compose.yml).

# Build stage: full install (Tailwind + esbuild live in devDependencies), then
# `pnpm run build` compiles the CSS bundle AND the esbuild client-JS bundle
# (public/dist/js). MSM_SKIP_POSTINSTALL=1 makes the install-time postinstall
# hook a no-op; the bundles are built explicitly after the source copy so the
# COPY ordering below decides exactly when Tailwind + esbuild re-run.
FROM node:24-alpine AS build
WORKDIR /app
ARG PNPM_VERSION=11.25.0
ENV MSM_SKIP_POSTINSTALL=1
# Pin pnpm directly instead of corepack (deprecated, being removed from Node):
# exact packageManager version, no shim, no second download.
RUN npm install -g pnpm@${PNPM_VERSION}
# Dependency layers key on the lockfile alone. `pnpm fetch` populates the store
# from pnpm-lock.yaml without reading package.json, so a version bump or a
# package.json script/field edit that doesn't move the lockfile re-fetches
# nothing. The runtime stage shares this cache-mounted store id, so its --prod
# install reuses these downloads.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm fetch
COPY package.json ./
# Only postinstall.js has to exist for `pnpm install` to run its (here no-op)
# lifecycle hook - copying all of scripts/ would tie this layer to every seed
# and QA script.
COPY scripts/postinstall.js ./scripts/postinstall.js
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --offline
# Style + client-JS build inputs. assets/css/input.css pins its Tailwind sources
# with source(none), so the scan set is exactly src/ + views/ + public/js - all
# copied here. src/ is in that set on purpose (status/quota colour literals in
# src/web/app.js), so a src change DOES re-run this layer; that's correct, not a
# cache miss to design around. build-js.js is the only script the build reads.
COPY assets ./assets
COPY views ./views
COPY public ./public
COPY scripts/build-js.js ./scripts/build-js.js
COPY src ./src
RUN pnpm run build
# Production dependencies, resolved here from the same store, so the runtime
# image needs no package manager at all. --offline: the store already holds
# everything (pnpm fetch above); the cache mount is a separate filesystem, so
# pnpm copies rather than hard-links and the result is a self-contained tree.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    mkdir /prod && cp package.json pnpm-lock.yaml pnpm-workspace.yaml /prod/ && \
    cd /prod && pnpm install --frozen-lockfile --prod --offline --ignore-scripts

# Runtime stage: production deps + the app, with the built CSS + JS bundles overlaid.
FROM node:24-alpine
WORKDIR /app
# LOG_PRETTY=false: logs are newline-delimited JSON on stdout for the container
# runtime to collect; the pretty transport is a dev-only convenience.
ENV NODE_ENV=production \
    MSM_SKIP_POSTINSTALL=1 \
    DATA_DIR=/data \
    PANEL_HOST=0.0.0.0 \
    PANEL_PORT=25564 \
    LOG_PRETTY=false
# Production node_modules come ready-made from the build stage: no pnpm (and
# none of its download and script machinery) ships in the runtime image.
COPY package.json ./
COPY --from=build /prod/node_modules ./node_modules
# Least-volatile inputs first so a src-only change re-copies as little as possible.
COPY --from=build /app/public ./public
COPY views ./views
COPY scripts ./scripts
COPY src ./src
EXPOSE 25564
VOLUME /data
# Runs as root: the mounted Docker socket needs it (the host's docker-group GID
# is unknowable at build time), and a socket-holding container is already
# root-equivalent on the host - dropping privileges here would only pretend.
# To narrow what the panel can ask the daemon for, put a socket proxy in front
# of it instead: deploy/docker-compose.socket-proxy.yml.
# /healthz is unauthenticated, checks the DB, and returns 503 on failure - a
# truer liveness signal than /login (which only proves the HTTP listener is up).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PANEL_PORT}/healthz" || exit 1
CMD ["node", "src/server.js"]
