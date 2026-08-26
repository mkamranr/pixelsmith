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
RUN pip install --no-cache-dir --require-hashes=false -r requirements.txt

COPY services/inference/*.py ./
# Verified weights, baked in. Read-only at runtime.
COPY assets/vendor/models /models

RUN useradd --system --uid 1001 --create-home inference && chown -R inference /srv
USER inference

ENV PIXELSMITH_MODEL_DIR=/models \
    PIXELSMITH_THREADS=2

EXPOSE 8188
ENTRYPOINT ["/usr/bin/tini", "--"]
HEALTHCHECK --interval=30s --timeout=4s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8188/healthz').status==200 else 1)"
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8188", "--workers", "1"]
