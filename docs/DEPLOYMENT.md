# Deployment

Pixelsmith ships as four containers and one Compose file. This document covers
getting it running, configuring it, and installing it on a machine with no
internet access. For day-to-day operation — retention, backups, capacity,
diagnosing a failed job — see the [runbook](RUNBOOK.md).

- [What you need](#what-you-need)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Behind a reverse proxy](#behind-a-reverse-proxy)
- [Accounts](#accounts)
- [Scaling](#scaling)
- [Installing on an air-gapped machine](#installing-on-an-air-gapped-machine)
- [Giving the workers a language model](#giving-the-workers-a-language-model)
- [Upgrading](#upgrading)
- [Verifying the air gap](#verifying-the-air-gap)

## What you need

- Docker 24 or newer, with Compose v2 (`docker compose`, not `docker-compose`)
- **4 GB RAM** for the web and processing tiers. Add 2 GB if you want the
  neural tools (upscale, background removal, face detection)
- **~6 GB disk** for images, plus room for job files: budget for the largest
  batch anyone will submit, times the retention window
- x86-64 or arm64. No GPU: inference is CPU-only by design, so an upscale of a
  large image takes tens of seconds, which is why there is a queue

No internet access is required at run time, and none is used.

## Quick start

```bash
git clone <this-repo> pixelsmith && cd pixelsmith
docker compose up -d --build
```

That builds the images, creates the volumes, runs the database migrations on
first boot and starts everything. The pages are on
**http://localhost:8080**.

```bash
docker compose ps                    # all four healthy?
curl -fsS localhost:8080/healthz     # {"ok":true,…}
```

Nothing else is needed: there is no separate migration step, no seed data, and
no account to create unless you want accounts.

## Configuration

Everything is set through the environment, read by Compose from a `.env` file
beside `docker-compose.yml`. Copy [`.env.example`](../.env.example) and edit.

### Where it listens

| Variable | Default | Notes |
|---|---|---|
| `PUBLISH_PORT` | `8080` | Host port for the web tier |
| `PUBLISH_ADDR` | `0.0.0.0` | Bind to `127.0.0.1` if a proxy fronts it |
| `TRUST_PROXY` | `false` | Set `true` only behind a proxy you control |

### Limits and retention

| Variable | Default | Notes |
|---|---|---|
| `MAX_UPLOAD_BYTES` | `209715200` (200 MB) | Per file |
| `MAX_FILES_PER_JOB` | `30` | Per job |
| `RETENTION_HOURS` | `2` | How long results survive after a job finishes |
| `JOB_TIMEOUT_MINUTES` | `15` | A job past this is killed and reported failed |

Retention is the setting to think hardest about. It is the difference between
"the files are gone" and "the files are on a disk somebody can image".

### Capacity

| Variable | Default | Notes |
|---|---|---|
| `RUNNER_REPLICAS` | `2` | Worker containers |
| `RUNNER_CONCURRENCY` | `2` | Jobs at once per worker |
| `INFERENCE_THREADS` | `2` | CPU threads for the neural tools |

### Security and identity

| Variable | Default | Notes |
|---|---|---|
| `AUTH_MODE` | `open` | `open` = no accounts; `accounts` = sign-in required |
| `COOKIE_SECRET` | generated | Written to the data volume on first boot if unset |
| `BOOTSTRAP_ADMIN_EMAIL` | — | First administrator, `accounts` mode only |
| `BOOTSTRAP_ADMIN_PASSWORD` | — | Used once, at first boot |
| `ALLOWED_RENDER_HOSTS` | empty | Hosts the HTML tools may fetch. Empty = none |

`ALLOWED_RENDER_HOSTS` is the only setting that can give a container a reason to
make an outbound request, and it is empty by default. Anything you add is a host
the headless browser is permitted to load — an internal wiki, say. Pasted markup
needs no entry here.

### Logging

| Variable | Default | Notes |
|---|---|---|
| `LOG_LEVEL` | `info` | `trace`…`error` for the Node tiers, `INFO` for Python |

Logs carry job ids, tool names, sizes and outcomes. They do not carry filenames
or file contents.

## Behind a reverse proxy

The stack speaks HTTP and terminates no TLS. Put your existing proxy in front of
it, set `TRUST_PROXY=true`, and bind the published port to localhost:

```
PUBLISH_ADDR=127.0.0.1
TRUST_PROXY=true
```

Two things the proxy must allow, or the app will appear broken in ways that are
hard to diagnose:

- **Uploads as large as `MAX_UPLOAD_BYTES`.** nginx defaults to 1 MB
  (`client_max_body_size`), which rejects almost every real PDF.
- **Unbuffered `text/event-stream`** on `/api/jobs/*/events`, or live progress
  stalls and falls back to polling. In nginx: `proxy_buffering off`.

## Accounts

The default is no accounts: anyone who can reach the page can use it, and jobs
are scoped to a browser. That suits an isolated network where reaching the page
is already the access control.

To require sign-in:

```
AUTH_MODE=accounts
BOOTSTRAP_ADMIN_EMAIL=you@example.internal
BOOTSTRAP_ADMIN_PASSWORD=<a long one, used once>
```

Passwords are hashed with Argon2id. Sessions are cookie-backed and expire after
12 hours (`SESSION_TTL_HOURS`, set on the `api` service rather than in
`.env.example`, since almost nobody changes it). Every job is attributed to an account in an append-only
audit log, which is usually the point of turning accounts on. Administration —
adding people, resetting a password, reading the audit log — is described in the
[runbook](RUNBOOK.md).

## Scaling

The web tier is a single replica by design: it owns the SQLite database, which is
in WAL mode and comfortable with one writer. Workers scale freely.

```bash
docker compose up -d --scale runner=6
```

If the web tier ever needs replicas, the database access is behind a repository
layer with Drizzle, so moving to Postgres is a dialect change and a migration
run rather than a rewrite. It has not been needed.

## Installing on an air-gapped machine

**On a connected machine**, build the bundle:

```bash
./infra/bundle/fetch-assets.sh      # models and fonts, each checked against a pinned hash
make -C infra/bundle images         # build all four images
make -C infra/bundle bundle         # docker save + compose file + checksums
```

That produces `pixelsmith-<version>-<arch>.tar.zst` alongside
`docker-compose.yml`, `.env.example`, `install.sh`, `SHA256SUMS` and the
runbook. Copy the directory across on whatever medium your network allows.

**On the isolated machine:**

```bash
sha256sum -c SHA256SUMS             # verify before trusting
zstd -d pixelsmith-*.tar.zst -c | docker load
./install.sh                        # generates secrets, creates volumes, starts
```

`install.sh` is idempotent and prints what it did. Nothing in the process
reaches the network; if anything tries, it fails loudly rather than hanging.

Every bundled model and font is listed in
[`infra/bundle/assets.manifest`](../infra/bundle/assets.manifest) as
`target|url|licence|sha256`. `fetch-assets.sh` refuses to proceed on a checksum
mismatch: on an isolated deployment nobody can re-download a substituted model
later, so the integrity check happens once, on the build machine, loudly.
Nothing copyleft or research-only is included, which is why some otherwise
obvious model choices are not used.

## Giving the workers a language model

A few tools — summarising a document, for one — need a language model.
Pixelsmith speaks the OpenAI API, so anything you run yourself works: vLLM,
Ollama, llama.cpp. Configure it under **Settings → Language model**. Those tools
stay hidden until a model has actually answered, because a menu entry that
always fails is worse than no menu entry.

The catch is worth understanding before you debug it. The pages are served by
`api` and the work is done by `runner`, and **`runner` has no route off this host
by design**. So a model on your laptop or elsewhere on the LAN is reachable from
the web tier and not from the workers — and it is the workers that need it. The
settings page reports both separately for exactly this reason.

The best answer is to run the model inside this stack on the `internal` network,
where no route out is needed at all. Failing that, there is a named override
that gives the workers a route:

```bash
docker compose -f docker-compose.yml -f docker-compose.model-access.yml up -d
```

It has to be named on the command line because it does widen what the workers
can reach. The [runbook](RUNBOOK.md#giving-it-a-language-model) covers the three
options and what each costs you.

## Upgrading

```bash
docker compose pull || docker compose build
docker compose up -d
```

Migrations run at boot and are forward-only. Back up the database first — one
command, in the [runbook](RUNBOOK.md#backups). Job files are ephemeral by
design and are not worth preserving across an upgrade.

## Verifying the air gap

Redis, the workers and the inference sidecar sit on a Compose network declared
`internal: true`, so they have no route off the host at all. That is a property
you can test rather than a claim to believe, and the
[runbook](RUNBOOK.md#confirming-the-air-gap) gives the commands — including a
control case, so a passing result means something.

The web tier is the one exception: it is on both networks, because it has to
accept connections from browsers. It initiates nothing outbound.
