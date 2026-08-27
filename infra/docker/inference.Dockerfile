# Pixelsmith inference sidecar.
#
# CPU-only ONNX and OpenCV. Model weights are COPYied in from assets/vendor,
# which fetch-assets.sh populated and checksum-verified on the build machine —
# this image never downloads a model.

FROM python:3.11-slim-bookworm AS runtime
WORKDIR /srv
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

# opencv-contrib-python-headless still needs these shared libraries present.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libglib2.0-0 \
      tini \
    && rm -rf /var/lib/apt/lists/*

COPY services/inference/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY services/inference/*.py ./

# Model weights.
#
# Fetched here, during the build, and verified against the SHA-256 values
# pinned in the manifest. That keeps a fresh checkout buildable with one
# command while still refusing a substituted or corrupted model — which is the
# only moment such a substitution can be caught, since the deployed machine has
# no network to re-download from.
COPY infra/bundle/assets.manifest infra/bundle/fetch-assets.sh /build/infra/bundle/
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && cd /build && bash infra/bundle/fetch-assets.sh \
    && mkdir -p /models && cp -r /build/assets/vendor/models/. /models/ \
    && rm -rf /build \
    && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Its own uid, so a model exploit is not also a job-store compromise, but the
# group that owns /data, because it writes results into the shared volume.
RUN if ! getent group 1000 >/dev/null; then groupadd --gid 1000 shared; fi \
    && useradd --system --uid 1001 --gid 1000 --create-home inference \
    && chown -R 1001:1000 /srv
USER inference

ENV PIXELSMITH_MODEL_DIR=/models \
    PIXELSMITH_THREADS=2

EXPOSE 8188
ENTRYPOINT ["/usr/bin/tini", "--"]
HEALTHCHECK --interval=30s --timeout=4s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8188/healthz').status==200 else 1)"
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8188", "--workers", "1"]
