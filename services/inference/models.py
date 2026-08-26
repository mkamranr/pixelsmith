"""Model loading and the three inference operations.

Kept separate from the HTTP layer so each operation is a plain function over
numpy arrays, testable without a server.

Everything here is CPU-only and single-threaded per request; concurrency is the
queue's job, not this service's.
"""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

MODEL_DIR = Path(os.environ.get("PIXELSMITH_MODEL_DIR", "/models"))

# U-2-Net expects 320x320 input, normalised with the ImageNet statistics it was
# trained against.
U2NET_SIZE = 320
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# Above this, super-resolution runs tile by tile. A 4x upscale of a large photo
# would otherwise allocate several gigabytes in one go.
UPSCALE_TILE = 512
UPSCALE_OVERLAP = 16


class ModelMissing(RuntimeError):
    """Raised when a weight file is absent, so the API can say which one."""


def _require(name: str) -> Path:
    path = MODEL_DIR / name
    if not path.is_file():
        raise ModelMissing(f"model file not found: {path}")
    return path


@lru_cache(maxsize=4)
def _onnx_session(name: str) -> ort.InferenceSession:
    """Sessions are cached: loading U2Net costs ~1s and 170MB."""
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.intra_op_num_threads = int(os.environ.get("PIXELSMITH_THREADS", "2"))
    return ort.InferenceSession(str(_require(name)), options, providers=["CPUExecutionProvider"])


@lru_cache(maxsize=4)
def _superres(model: str, scale: int):
    sr = cv2.dnn_superres.DnnSuperResImpl_create()
    sr.readModel(str(_require(f"{model.upper()}_x{scale}.pb")))
    sr.setModel(model.lower(), scale)
    return sr


@lru_cache(maxsize=1)
def _face_detector_path() -> str:
    return str(_require("face_detection_yunet.onnx"))


def read_image(path: str) -> np.ndarray:
    """Read an image, keeping any alpha channel.

    IMREAD_UNCHANGED deliberately ignores the EXIF orientation flag, and
    IMREAD_COLOR (which honours it) would discard alpha. The caller is
    responsible for handing over pixels that are already upright: the Node
    worker bakes rotation in before it calls this service, so orientation has a
    single authority. Do not add a second one here.
    """
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError(f"could not read image: {path}")
    if img.ndim == 2:  # greyscale
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    return img


def write_image(path: str, img: np.ndarray) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(path, img):
        raise ValueError(f"could not write image: {path}")


def _alpha_matte(img_bgr: np.ndarray, model: str) -> np.ndarray:
    """Run U-2-Net and return a full-size single-channel alpha matte."""
    session = _onnx_session(f"{model}.onnx")
    height, width = img_bgr.shape[:2]

    rgb = cv2.cvtColor(img_bgr[:, :, :3], cv2.COLOR_BGR2RGB)
    resized = cv2.resize(rgb, (U2NET_SIZE, U2NET_SIZE), interpolation=cv2.INTER_AREA)
    normalised = (resized.astype(np.float32) / 255.0 - IMAGENET_MEAN) / IMAGENET_STD
    tensor = np.transpose(normalised, (2, 0, 1))[np.newaxis, ...].astype(np.float32)

    # U-2-Net emits several side outputs; the first is the refined one.
    prediction = session.run(None, {session.get_inputs()[0].name: tensor})[0]
    matte = prediction[0, 0]

    spread = matte.max() - matte.min()
    matte = (matte - matte.min()) / spread if spread > 0 else np.zeros_like(matte)

    return (cv2.resize(matte, (width, height), interpolation=cv2.INTER_LINEAR) * 255).astype(np.uint8)


def remove_background(
    src: str,
    dst: str,
    model: str = "u2net",
    background: str | None = None,
    feather: int = 2,
) -> dict:
    img = read_image(src)
    alpha = _alpha_matte(img, model)

    if feather > 0:
        # A single-pixel hard edge looks cut out; a slight blur reads as a
        # genuine boundary without visibly softening the subject.
        k = feather * 2 + 1
        alpha = cv2.GaussianBlur(alpha, (k, k), 0)

    bgr = img[:, :, :3]

    if background:
        colour = tuple(int(background.lstrip("#")[i : i + 2], 16) for i in (4, 2, 0))  # BGR
        backdrop = np.full_like(bgr, colour, dtype=np.uint8)
        weight = (alpha.astype(np.float32) / 255.0)[:, :, np.newaxis]
        composed = (bgr.astype(np.float32) * weight + backdrop.astype(np.float32) * (1 - weight))
        write_image(dst, composed.astype(np.uint8))
    else:
        write_image(dst, np.dstack([bgr, alpha]))

    return {"width": int(img.shape[1]), "height": int(img.shape[0]), "transparent": background is None}


def _upsample_tiled(sr, img: np.ndarray, scale: int) -> np.ndarray:
    """Upscale in overlapping tiles, then trim the overlap back off."""
    height, width = img.shape[:2]
    out = np.zeros((height * scale, width * scale, 3), dtype=np.uint8)

    for y in range(0, height, UPSCALE_TILE):
        for x in range(0, width, UPSCALE_TILE):
            x0 = max(0, x - UPSCALE_OVERLAP)
            y0 = max(0, y - UPSCALE_OVERLAP)
            x1 = min(width, x + UPSCALE_TILE + UPSCALE_OVERLAP)
            y1 = min(height, y + UPSCALE_TILE + UPSCALE_OVERLAP)

            tile = sr.upsample(img[y0:y1, x0:x1])

            # Offsets of the useful region inside the upscaled tile.
            left = (x - x0) * scale
            top = (y - y0) * scale
            keep_w = min(UPSCALE_TILE, width - x) * scale
            keep_h = min(UPSCALE_TILE, height - y) * scale

            out[y * scale : y * scale + keep_h, x * scale : x * scale + keep_w] = tile[
                top : top + keep_h, left : left + keep_w
            ]

    return out


def upscale(src: str, dst: str, scale: int = 2, model: str = "fsrcnn") -> dict:
    img = read_image(src)
    bgr = img[:, :, :3]
    sr = _superres(model, scale)

    height, width = bgr.shape[:2]
    result = (
        _upsample_tiled(sr, bgr, scale)
        if width > UPSCALE_TILE or height > UPSCALE_TILE
        else sr.upsample(bgr)
    )

    write_image(dst, result)
    return {"width": int(result.shape[1]), "height": int(result.shape[0]), "scale": scale}


def detect_faces(src: str, confidence: float = 0.7) -> list[dict]:
    img = read_image(src)
    height, width = img.shape[:2]
    bgr = img[:, :, :3]

    detector = cv2.FaceDetectorYN_create(
        _face_detector_path(), "", (width, height), confidence, 0.3, 5000
    )
    detector.setInputSize((width, height))
    _, faces = detector.detect(bgr)

    if faces is None:
        return []

    return [
        {
            "x": int(max(0, f[0])),
            "y": int(max(0, f[1])),
            "width": int(f[2]),
            "height": int(f[3]),
            "score": float(f[14]),
        }
        for f in faces
    ]


def redact_regions(
    src: str,
    dst: str,
    regions: list[dict],
    method: str = "blur",
    strength: int = 24,
) -> dict:
    """Obscure the given rectangles. Used for both detected and manual boxes."""
    img = read_image(src)
    height, width = img.shape[:2]

    for region in regions:
        # Clamp and pad slightly: a detection box crops tight to the face, and
        # an ear or hairline left visible defeats the point.
        pad = int(max(region["width"], region["height"]) * 0.12)
        x0 = max(0, region["x"] - pad)
        y0 = max(0, region["y"] - pad)
        x1 = min(width, region["x"] + region["width"] + pad)
        y1 = min(height, region["y"] + region["height"] + pad)
        if x1 <= x0 or y1 <= y0:
            continue

        patch = img[y0:y1, x0:x1]

        if method == "box":
            img[y0:y1, x0:x1] = 0
        elif method == "pixelate":
            # Blocks scaled to the region, so a small face is not left readable.
            blocks = max(2, int(min(x1 - x0, y1 - y0) / max(4, strength // 2)))
            small = cv2.resize(patch, (blocks, blocks), interpolation=cv2.INTER_AREA)
            img[y0:y1, x0:x1] = cv2.resize(
                small, (x1 - x0, y1 - y0), interpolation=cv2.INTER_NEAREST
            )
        else:
            # Kernel must be odd, and large enough that detail cannot survive.
            k = max(3, (strength * 2) | 1)
            img[y0:y1, x0:x1] = cv2.GaussianBlur(patch, (k, k), 0)

    write_image(dst, img)
    return {"width": int(width), "height": int(height), "regions": len(regions)}
