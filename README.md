# Pixelsmith

A self-hosted image workshop for networks with no internet access. Compress,
resize, convert, crop, rotate, watermark, upscale, cut out backgrounds, redact
faces, build memes, render HTML to pictures, and edit photos — all processed on
your own machine, with no third-party service, no API key and no telemetry.

Built to be handed to an air-gapped server as a single directory and installed
with one script.

## Why it exists

The public image tools are convenient and entirely unusable when the images
cannot leave the building. Pixelsmith provides the same capabilities as a service
you run yourself, and treats "nothing reaches the outside" as a property of the
deployment that is tested, not a claim in a README.

## The twelve tools

| Tool | What it does |
|---|---|
| **Compress** | Smaller files at the same apparent quality, or to a target size in KB |
| **Resize** | By pixels or percentage, with aspect lock and a don't-enlarge guard |
| **Crop** | A rectangle out of one image or a whole batch |
| **Rotate & flip** | Quarter turns, arbitrary angles, mirroring; EXIF-aware |
| **Convert** | Between JPEG, PNG, WebP, AVIF and TIFF; reads HEIC and SVG |
| **Upscale** | Neural 2x/4x enlargement that recovers detail scaling cannot |
| **Remove background** | Cuts out the subject; transparent PNG or a colour behind it |
| **Watermark** | Text in a corner or tiled across the frame, at any opacity |
| **Blur faces** | Finds faces and blurs, pixelates or blacks them out |
| **Meme generator** | Bold captions top and bottom |
| **HTML to image** | Renders pasted markup through a confined headless browser |
| **Photo editor** | Crop, straighten, adjust and annotate, previewed live |

Every tool takes batches, streams results as a zip, and can pass its output
straight into another tool without re-uploading.

## Design notes worth knowing

**Files are ephemeral.** Uploads and results are deleted a configurable interval
after a job finishes (two hours by default). A sweeper also removes orphaned
directories that have no database row, so a crash cannot leave images behind
indefinitely.

**Metadata is stripped.** EXIF, GPS coordinates and camera serial numbers are
dropped from every processed image. That is the default and there is no option to
keep them.

**Uploads are identified by their bytes, not their names.** A `.png` containing
JPEG data is reported as what it is. Decompression bombs, truncated files and
oversized dimensions are refused before a decoder sees them.

**SVG is refused rather than sanitised** when it contains a script, a `DOCTYPE`
entity or an external reference. SVG is a program; rewriting one safely is harder
than declining it, and a clear refusal tells the user what was wrong.

**It is a multi-page application.** Server-rendered pages, forms that post
normally, and a job page that falls back to a meta refresh. Live progress and the
thumbnail previews are progressive enhancement — turn JavaScript off and
everything still works, just less smoothly. There is no client bundle to build.

**The editor sends a recipe, not pixels.** The browser edits a downscaled
preview and accumulates an ordered list of operations; the server replays it at
full resolution through the same primitives the batch tools use. One
implementation of each transform, and a 60-megapixel TIFF never enters a canvas.

## Architecture

```
Browser ──▶ api (Fastify, renders pages + REST API)
              │
              ├── SQLite ......... accounts, jobs, audit log
              ├── Redis .......... BullMQ queues
              └── shared volume .. job files
                     ▲
       runner ───────┤  sharp/libvips, Chromium
    (n replicas)     │
                     └── inference (Python: ONNX, OpenCV) — CPU only
```

`api` is a single replica and owns the database schema. `runner` scales out.
Redis, the runners and the inference sidecar sit on a Docker network declared
`internal: true`, so they have no route off the host at all.

## Running it locally

Needs Node 22+. Redis is optional — the in-process queue driver means you can
develop with nothing else running.

```bash
npm install
npx tsc -b
npm test

# ML tools also need the Python sidecar; skip this and they report
# themselves unavailable rather than failing obscurely.
./infra/bundle/fetch-assets.sh
python3 -m venv .venv-inference
./.venv-inference/bin/pip install -r services/inference/requirements.txt
PIXELSMITH_MODEL_DIR="$PWD/assets/vendor/models" \
  ./.venv-inference/bin/python -m uvicorn main:app --app-dir services/inference --port 8188 &

PORT=8099 INFERENCE_URL=http://127.0.0.1:8188 npx tsx apps/api/src/main.ts
```

Open http://localhost:8099. On an empty database the first administrator is
created automatically and its generated password printed once to the log.

## Building the offline bundle

On a machine **with** internet:

```bash
make -C infra/bundle all      # fetch assets, build images, assemble the bundle
make -C infra/bundle verify   # prove the stack runs with egress blocked
```

That produces `infra/bundle/out/pixelsmith-<version>/` containing the images, the
compose file, the installer, a checksum manifest and the runbook. Copy that
directory to the isolated server and run `./install.sh`. Nothing is downloaded
there.

Model weights and every other vendored binary are pinned by SHA-256 in
`infra/bundle/assets.manifest`, and the fetch script refuses to continue on a
mismatch — on an air-gapped box nobody can re-download a substituted model later.

## Repository layout

```
apps/api/            Fastify server: pages, REST API, auth, uploads
workers/runner/      Consumes queued jobs; one binary serves every queue
services/inference/  Python sidecar: ONNX + OpenCV, CPU only
packages/core/       Tool registry and every image operation
packages/jobs/       Job execution, queue drivers, storage, purge sweeper
packages/db/         Drizzle schema, migrations, repositories
packages/contracts/  Types shared across every package
infra/               Dockerfiles, compose, and the offline bundle tooling
```

### Adding a tool

Write one module in `packages/core/src/tools/` exporting an `id`, a Zod schema
for its parameters, a declarative field list, and a `run()`. Add it to the array
in `tools/index.ts`. The API validates from it, the worker dispatches from it,
the web form renders from it and the API docs generate from it — there is no
route, template or documentation to edit.

## Licences

Pixelsmith is MIT. Bundled model weights are recorded in
`infra/bundle/assets.manifest` with their source and licence, and all are
Apache-2.0: U²-Net (background removal), YuNet (face detection) and FSRCNN
(upscaling). Copyleft and non-commercial weights are deliberately excluded — in
particular the widely used AGPL face detectors, which would have implicated the
whole deployment. Rendered text uses DejaVu from the distribution, not a
proprietary typeface.

This is an independent implementation, not affiliated with or derived from any
existing product.
