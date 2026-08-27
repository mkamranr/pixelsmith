# Pixelsmith

<p align="center">
  <img src="assets/brand/pixelsmith-source.png" alt="Pixelsmith — image and PDF tools, all in one" width="420">
</p>

A self-hosted image and PDF workshop for networks with no internet access.
Compress, resize, convert, crop, rotate, watermark, upscale, cut out backgrounds,
redact faces, build memes, edit photos — and merge, split, sign, redact, compare,
protect, OCR and convert PDFs. All processed on your own machine, with no
third-party service, no API key and no telemetry.

Built to be handed to an air-gapped server as a single directory and installed
with one script.

## What it looks like

<p align="center">
  <img src="docs/screenshots/home.jpg" alt="The tool catalogue, grouped by what each tool is for" width="820">
</p>

Every tool gets a workspace rather than a form: the picture is on screen while
the settings are chosen, so the effect of a setting is visible before anything is
submitted.

<p align="center">
  <img src="docs/screenshots/compress-images.jpg" alt="Compressing an image, with the picture alongside the settings" width="820">
</p>

PDF tools lay the pages out as thumbnails. Pages are dragged into order, turned,
duplicated or dropped — across several documents at once — and what comes out is
one document arranged exactly as it was left.

<p align="center">
  <img src="docs/screenshots/organise-pdf.jpg" alt="Organise PDF: every page of every document, draggable" width="820">
</p>

Anything geometric is done on the document itself. Cropping is a rectangle
dragged on the page, not four numbers typed from memory — though the numbers are
still there, and still authoritative, for anyone who wants them.

<p align="center">
  <img src="docs/screenshots/crop-pdf.jpg" alt="Cropping a PDF by dragging on the page, with a rail of pages alongside" width="820">
</p>

Everything the pages can do, a script can do. The API is documented in the app
as well as in [docs/API.md](docs/API.md).

<p align="center">
  <img src="docs/screenshots/rest-api.jpg" alt="The built-in REST API reference" width="820">
</p>

## Documentation

| | |
|---|---|
| [docs/API.md](docs/API.md) | Every endpoint, every tool's parameters, worked examples |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Installing, configuring, and the air-gapped bundle |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Running it: retention, backups, capacity, diagnosing failures |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How it is put together, and why |

## Why it exists

The public image tools are convenient and entirely unusable when the images
cannot leave the building. Pixelsmith provides the same capabilities as a service
you run yourself, and treats "nothing reaches the outside" as a property of the
deployment that is tested, not a claim in a README.

## The tools

Two menus, because they are two jobs: **Images** and **PDF**.

### Images

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

### PDF

| Tool | What it does |
|---|---|
| **Merge** | Several documents into one, in the order you choose |
| **Split** | Every page separately, or the ranges you name |
| **Organise** | Reorder, duplicate or drop pages by clicking them |
| **Rotate** | Quarter turns, per page or throughout |
| **Crop** | Trim the margins off every page |
| **Compress** | Smaller documents by rebuilding what is oversized |
| **PDF to image** | Every page as JPEG or PNG, at a resolution you pick |
| **Images to PDF** | A folder of pictures into one document |
| **Office to PDF** | Word, Excel, PowerPoint and OpenDocument files |
| **PDF to Word** | Editable text, in text boxes rather than flowing paragraphs |
| **PDF to Excel** | The text as rows, with columns recovered from the gaps |
| **PDF to PowerPoint** | Each page as an editable slide |
| **HTML to PDF** | Pasted markup or an allowlisted internal page |
| **OCR** | Makes a scan searchable — English, Arabic, or both |
| **Page numbers** | Numbered where you want them, in the format you want |
| **Watermark** | Text across one page or tiled over all of them |
| **Sign** | A scanned signature or a typed name, placed where you drag it |
| **Redact** | Blacks out text and removes it from the file, not just covers it |
| **Compare** | Two versions, with a report of what changed on which page |
| **Protect** | AES-256 encryption, with printing and copying controlled |
| **Unlock** | Removes a password you know |
| **Repair** | Rebuilds a damaged document as far as it can be read |
| **Summarise** | Reads a document and writes a summary — needs a language model |

Every tool takes batches, streams results as a zip, and can pass its output
straight into another tool without re-uploading. PDF tools show the pages as
thumbnails, so a page range is chosen by clicking rather than typed from memory.

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

**Redaction removes, it does not cover.** A black rectangle drawn over live
text leaves the words in the file for anyone who selects them. Redacting rebuilds
each page as an image, so the hidden text is genuinely gone — and the document
stops being searchable, which the tool says plainly and OCR can undo.

**Arabic and other non-Latin text is laid out by a real text engine.** The PDF
standard fonts cannot encode it, and drawing glyphs one at a time would leave
Arabic letters unjoined and in the wrong order. Text outside Latin-1 is shaped by
librsvg and placed as an image; everything else stays selectable text.

**PDF to Word and Excel are honest about what they are.** A PDF records where
words sit, not how they were laid out, so a conversion cannot recover a structure
that was never stored. The blurbs say what you will actually get rather than
implying a perfect round trip.

**A tool that cannot work is not offered.** Summarising needs a language model,
which you point at your own vLLM, Ollama or llama.cpp under Settings. Until one
has actually answered — checked by the workers, which are the tier that has to
reach it, not by the web tier that happens to be able to — the tools that need it
are absent from the menus, from the home page and from the API's availability
flag, and are refused at the door with a reason. A menu entry that always fails
is worse than no menu entry.

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

## Running it with Docker

On any machine with Docker and Docker Compose, from a checkout of this repo:

```bash
docker compose up --build
```

Then open **http://localhost:8080**. There is nothing to configure, no `.env`
to write and no sign-in: the tools are open to anyone who can reach the host.

The build needs internet access — it installs system packages and downloads the
model weights, each verified against the SHA-256 values pinned in
`infra/bundle/assets.manifest`. The *deployment* needs no network at all; that
is the point. Nothing in the running stack reaches outward.

What comes up:

| Service | Role |
|---|---|
| `api` | Serves the pages and the REST API. The only published port. |
| `runner` | Processes jobs. Carries libvips, Chromium, qpdf, LibreOffice and Tesseract. |
| `inference` | CPU-only ONNX models for background removal, upscaling and face detection. |
| `redis` | The job queue. |

Useful variations:

```bash
docker compose up -d                          # background
docker compose logs -f api runner             # follow
docker compose up -d --scale runner=4         # more parallel work
PUBLISH_PORT=9000 docker compose up            # different port
AUTH_MODE=accounts docker compose up           # turn per-user sign-in on
docker compose down                            # stop, keeping data
docker compose down -v                         # stop and erase everything
```

The first build takes a while — LibreOffice is most of it. Subsequent builds
reuse the layer cache.

### Proving the air gap

Only `api` is published. Everything that touches your files — the runners and the
inference sidecar — sits on a Docker network declared `internal: true`, which
Docker gives no NAT, so those containers have no route off the host whatever the
host can reach:

```bash
docker compose exec runner node -e "
const s=require('net').connect({host:'1.1.1.1',port:443,timeout:6000});
s.on('connect',()=>console.log('CONNECTED - egress exists'));
s.on('timeout',()=>console.log('no egress (correct)'));
s.on('error',e=>console.log('no egress (correct):',e.code));"
```

`api` is also on the `edge` network, since a published port cannot be routed into
an internal one, so its outbound reach is the host's — none on an air-gapped
server. [The runbook](docs/RUNBOOK.md#confirming-the-air-gap) covers how to check
this properly, including why the obvious `wget` one-liner reports a false pass.

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
