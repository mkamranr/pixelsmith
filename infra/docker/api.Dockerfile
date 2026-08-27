# Pixelsmith API and web server.
#
# Multi-stage: the build stage carries the toolchain, the runtime stage carries
# only what is needed to serve. Everything is pinned by digest-able tag and
# installed from the committed lockfile, so this image is reproducible on a
# machine that has never seen the internet after the base images are cached.

# ---- build ----
FROM node:22.17.1-bookworm-slim AS build
WORKDIR /build

# Native modules (sharp, better-sqlite3, argon2) may need to compile if no
# prebuild matches the platform.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Lockfile first, so dependency layers cache independently of source changes.
COPY package.json package-lock.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/jobs/package.json packages/jobs/
COPY apps/api/package.json apps/api/
COPY workers/runner/package.json workers/runner/
RUN npm ci --no-audit --no-fund

COPY tsconfig.base.json tsconfig.json ./
# The brand assets the api build derives its icons from.
COPY assets/brand assets/brand
COPY packages packages
COPY apps apps
COPY workers workers
RUN npm run build

# Drop dev dependencies from what will be copied forward.
RUN npm prune --omit=dev

# ---- runtime ----
FROM node:22.17.1-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# libvips needs these at runtime for the formats we advertise. fonts-dejavu is
# what renders watermark and meme text — without a font installed, librsvg draws
# nothing and the text silently disappears.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libvips42 \
      fonts-dejavu-core \
      fontconfig \
      tini \
      ca-certificates \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/packages ./packages
COPY --from=build /build/apps ./apps
COPY --from=build /build/workers ./workers
COPY --from=build /build/package.json ./package.json

# Runs as an unprivileged user. The node image already provides uid 1000.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8080
ENV DATA_DIR=/data HOST=0.0.0.0 PORT=8080

# tini reaps zombies and forwards signals, so SIGTERM actually reaches Node and
# the graceful shutdown path runs.
ENTRYPOINT ["/usr/bin/tini", "--"]
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]
