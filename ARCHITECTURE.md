# Architecture

Four containers, one queue, one shared volume. This document explains why it is
arranged the way it is, since the shape follows from two constraints: **nothing
may reach the internet**, and **image and PDF decoders are hostile territory**.

```
Browser
   │  HTTP, session or visitor cookie
   ▼
┌──────────────────────────────────────────────┐
│ api  (Fastify, one replica)                  │   networks: edge + internal
│  renders pages · intake · REST · downloads   │
└───────┬──────────────────────┬───────────────┘
        │ SQLite (WAL)         │ Redis + BullMQ
        │ accounts, jobs,      │ queues: image | render | ml
        │ audit log            │
        ▼                      ▼
   /data (shared volume)   ┌─────────────────────────────┐
   jobs/<id>/{in,out}      │ runner  (n replicas)        │  internal only
                           │  sharp/libvips · qpdf ·     │
                           │  Chromium · LibreOffice ·   │
                           │  Tesseract · pdf-lib        │
                           └──────────┬──────────────────┘
                                      │ HTTP
                                      ▼
                           ┌─────────────────────────────┐
                           │ inference  (Python)         │  internal only
                           │  ONNX Runtime · OpenCV      │
                           │  CPU only, no egress        │
                           └─────────────────────────────┘
```

## The pieces

**`api`** renders every page, accepts uploads, validates parameters, writes the
job row and enqueues it. One replica, because it owns the SQLite database. It
never processes a file itself — that separation is what lets the tier that
touches untrusted bytes have no route to the network.

**`runner`** consumes the queues and does the work. Scale it freely
(`--scale runner=6`). It holds every native dependency: libvips, qpdf, Chromium,
LibreOffice, Tesseract.

**`inference`** is a small Python service for the neural tools. Node could run
ONNX, but the pre- and post-processing for alpha matting, tiled super-resolution
and detection NMS is already solved in `rembg` and OpenCV; reimplementing it in
TypeScript would buy nothing and cost weeks of subtle bugs. The boundary is
narrow and stateless: `runner` POSTs `{op, in_path, out_path, params}` and the
sidecar only touches the shared volume. It speaks to neither Redis nor SQLite.

**`redis`** carries the BullMQ queues, and nothing else. Job state lives in
SQLite; Redis is a work queue, not a source of truth.

## Why SQLite

Accounts, job rows and the audit log are low-volume. WAL mode handles one
writer's concurrency comfortably, and it removes a container from a machine
nobody can easily SSH into. Access goes through a repository layer built on
Drizzle, so if the web tier ever needs replicas, changing dialect is a migration
run rather than a rewrite. Raw SQL does not leave `packages/db`.

## The registry is the spine

Thirty-five tools only stay tractable because they share one declaration. A tool
is a module exporting an object:

```ts
export const resize: Tool = {
  id: 'resize',
  family: 'image',
  queue: 'image',
  accepts: ['image/jpeg', 'image/png', …],
  params: z.object({ mode: z.enum(['pixels', 'percent']), width: …, … }),
  ui: { group: 'optimize', icon: 'scaling', surface: 'canvas', fields: [ … ] },
  async run(ctx) { … },
}
```

That single declaration drives the tool page, the form fields, the menus, the
home page, parameter validation at intake, the REST API, the generated API
documentation and the worker's dispatch. **Adding a tool means writing one
module** — no route, no template, no documentation edit. Anywhere two things
could disagree about a tool, they read the same declaration instead.

The same principle appears in the small: one intake path for the browser form
and the API, so a file accepted in one is accepted in the other and the refusals
read identically; one function deciding who may read a job; one text-drawing
seam; one build authority.

## Job lifecycle

```
POST → validate params → write row → enqueue → 202
         ↓ (worker)
      running → progress → done | failed
         ↓ (sweeper, RETENTION_HOURS later)
      files deleted, row marked expired
```

Progress reaches the browser over server-sent events, with polling as the
fallback for proxies that buffer. Outputs download individually or as a
streamed zip. A finished job's outputs can become the inputs of the next job by
reference, so a forty-image batch is never uploaded twice.

The sweeper is authoritative: it also collects job directories with no matching
row, so a crash mid-upload cannot leave someone's photographs on disk
indefinitely.

## Trust boundaries

The interesting property is which tier can reach what:

| Tier | Untrusted bytes | Route off the host |
|---|---|---|
| `api` | uploads, briefly | yes — it must accept browsers |
| `runner` | yes, all of it | **none** |
| `inference` | yes | **none** |
| `redis` | no | **none** |

Redis, the workers and the sidecar are on a Compose network declared
`internal: true`. This is not a promise in a document; it is testable, and the
runbook gives the commands with a control case so a pass means something.

Decoders are where the risk concentrates, so: uploads are typed by their bytes
rather than their extension (`file-type`), and a declared type that disagrees
with the sniffed one is refused, which also disposes of polyglot files; pixel
and dimension limits are applied before a decoder sees anything; SVG containing a
script, a `DOCTYPE` entity or an external reference is refused rather than
sanitised, because SVG is a program and declining one is more honest than
rewriting it; every image runs through libvips rather than a shell of external
converters, so there is one decoder to reason about; Chromium runs as a non-root
user and may load no host but those explicitly listed in
`ALLOWED_RENDER_HOSTS`, which is empty by default. All three images run as a
non-root user.

## Server-rendered, on purpose

Pages are Nunjucks templates rendered by Fastify. Forms post normally. The job
page falls back to a meta refresh. Live progress, page thumbnails and the
direct-manipulation editors are progressive enhancement — turn JavaScript off
and everything still works, less smoothly.

There is no client bundle and no frontend build step. On an air-gapped machine
that is one fewer toolchain to install, one fewer thing to go stale, and a
page that renders before any script has parsed.

The one place this would have hurt is editing. The editor sends a **recipe**, not
pixels: the browser manipulates a downscaled preview and accumulates an ordered
list of operations; the server replays it at full resolution through the same
primitives the batch tools use. One implementation of each transform, and a
60-megapixel TIFF never enters a canvas.

## Repository layout

```
apps/api/            Fastify server: pages, REST, templates, static assets
workers/runner/      BullMQ consumer, dispatches on tool id
services/inference/  FastAPI + ONNX Runtime + OpenCV
packages/core/       The tool registry and every operation
packages/db/         Drizzle schema, migrations, repositories
packages/jobs/       Queue and storage abstractions
packages/contracts/  Shared error shapes
infra/docker/        One Dockerfile per image, multi-stage, non-root
infra/bundle/        Offline bundle: fetch, build, save, install
docs/                Runbook, API reference, deployment
```
