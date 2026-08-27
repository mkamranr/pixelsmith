# Pixelsmith job runner.
#
# Includes Chromium, because this one image serves every queue including HTML
# rendering. Shipping a separate slimmer image for non-render work would save
# roughly 200MB in the bundle but doubles what an operator has to load, tag and
# keep in step on a machine they cannot easily debug. One image is the better
# trade here; QUEUE_NAMES still lets render work be scaled separately.

FROM node:22.17.1-bookworm-slim AS build
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
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
RUN npm run build && npm prune --omit=dev

FROM node:22.17.1-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Chromium's own dependency list, plus libvips and fonts. Installed from the
# distro rather than downloaded by Playwright at runtime, because at runtime
# there is no network.
# Document tooling, all permissively licensed:
#   qpdf          Apache-2.0  encryption, decryption, repair, linearisation
#   libreoffice   MPL-2.0     Office formats to and from PDF
#   tesseract     Apache-2.0  optical character recognition
#
# Ghostscript is deliberately absent: it is AGPL, and pulling it in to squeeze
# a few more bytes out of a PDF would put a copyleft obligation on the whole
# deployment. The compress tool uses qpdf and page rebuilding instead.
#
# LibreOffice is the bulk of this image (~700MB). It is installed without the
# Java runtime, which it only needs for macros and database features that a
# format conversion never touches.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libvips42 \
      chromium \
      qpdf \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-ara \
      fonts-dejavu-core fonts-liberation fonts-noto-core fontconfig \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
      libpango-1.0-0 libcairo2 \
      tini ca-certificates \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/packages ./packages
COPY --from=build /build/apps ./apps
COPY --from=build /build/workers ./workers
COPY --from=build /build/package.json ./package.json

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

# Point Playwright at the distro Chromium instead of its own download.
ENV DATA_DIR=/data \
    CHROMIUM_PATH=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    QPDF_PATH=/usr/bin/qpdf \
    SOFFICE_PATH=/usr/bin/soffice \
    TESSERACT_PATH=/usr/bin/tesseract \
    # LibreOffice writes a profile on first run; give it a writable home.
    HOME=/tmp

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "workers/runner/dist/main.js"]
