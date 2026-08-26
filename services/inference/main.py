"""Pixelsmith inference sidecar.

A deliberately small HTTP surface over three CPU model operations. It reads and
writes files on the shared job volume and knows nothing about Redis, the
database, users or jobs — the Node worker owns all of that. Keeping the boundary
this narrow is what makes the Python dependency tolerable.

It listens only on the internal container network and has no route to the
outside; see the compose file's `internal: true` network.
"""
from __future__ import annotations

import logging
import os
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from models import (
    ModelMissing,
    detect_faces,
    redact_regions,
    remove_background,
    upscale,
)

logging.basicConfig(level=os.environ.get("PIXELSMITH_LOG_LEVEL", "INFO"))
log = logging.getLogger("pixelsmith.inference")

app = FastAPI(title="Pixelsmith inference", docs_url=None, redoc_url=None, openapi_url=None)


class RemoveBackgroundRequest(BaseModel):
    in_path: str
    out_path: str
    model: Literal["u2net", "u2netp"] = "u2net"
    # None means keep transparency; a hex colour composites onto that instead.
    background: str | None = None
    feather: int = Field(default=2, ge=0, le=20)


class UpscaleRequest(BaseModel):
    in_path: str
    out_path: str
    scale: Literal[2, 4] = 2
    model: Literal["fsrcnn"] = "fsrcnn"


class Region(BaseModel):
    x: int
    y: int
    width: int
    height: int


class BlurFacesRequest(BaseModel):
    in_path: str
    out_path: str
    method: Literal["blur", "pixelate", "box"] = "blur"
    strength: int = Field(default=24, ge=1, le=200)
    confidence: float = Field(default=0.7, ge=0.1, le=1.0)
    # Supplied by the operator to correct the detector: extra areas to hide, and
    # detections to ignore. Automated redaction you cannot correct is a liability.
    extra_regions: list[Region] = Field(default_factory=list)
    detect: bool = True


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok", "service": "inference"}


def _guard(fn, *args, **kwargs):
    """Turn model and input failures into useful HTTP errors, not stack traces."""
    try:
        return fn(*args, **kwargs)
    except ModelMissing as err:
        log.error("model missing: %s", err)
        raise HTTPException(status_code=503, detail=str(err)) from err
    except ValueError as err:
        log.warning("bad input: %s", err)
        raise HTTPException(status_code=422, detail=str(err)) from err
    except Exception as err:  # noqa: BLE001 - last line of defence for a worker
        log.exception("inference failed")
        raise HTTPException(status_code=500, detail=f"inference failed: {err}") from err


@app.post("/remove-background")
def post_remove_background(req: RemoveBackgroundRequest) -> dict:
    return _guard(
        remove_background,
        req.in_path,
        req.out_path,
        model=req.model,
        background=req.background,
        feather=req.feather,
    )


@app.post("/upscale")
def post_upscale(req: UpscaleRequest) -> dict:
    return _guard(upscale, req.in_path, req.out_path, scale=req.scale, model=req.model)


@app.post("/blur-faces")
def post_blur_faces(req: BlurFacesRequest) -> dict:
    regions: list[dict] = []

    if req.detect:
        regions.extend(_guard(detect_faces, req.in_path, confidence=req.confidence))

    regions.extend(r.model_dump() for r in req.extra_regions)

    result = _guard(
        redact_regions,
        req.in_path,
        req.out_path,
        regions,
        method=req.method,
        strength=req.strength,
    )
    # Report the count so the UI can tell the user when nothing was found —
    # silently returning the original image would be actively misleading.
    result["detected"] = len(regions)
    return result


@app.post("/detect-faces")
def post_detect_faces(req: BlurFacesRequest) -> dict:
    """Detection without redaction, so a reviewer can confirm before committing."""
    return {"faces": _guard(detect_faces, req.in_path, confidence=req.confidence)}
