# Pixelsmith runbook

Day-to-day operation of a Pixelsmith deployment on an isolated network.

Everything below assumes you are in the install directory (the one containing
`docker-compose.yml` and `.env`). All commands are offline.

---

## Everyday commands

```bash
docker compose ps                       # what is running
docker compose logs -f api              # follow the web server
docker compose logs -f runner           # follow job processing
docker compose restart api              # restart just the web tier
docker compose down                     # stop everything (data is kept)
docker compose up -d                    # start again
```

Job files and the database live in the `pixelsmith_jobdata` volume; the queue
lives in `pixelsmith_redisdata`. Neither is removed by `down`. Only
`down -v` destroys them.

---

## First sign-in

The first administrator is created once, on an empty database. If you did not
set `BOOTSTRAP_ADMIN_PASSWORD`, a password was generated and printed to the log
exactly once:

```bash
docker compose logs api | grep -i "generated password"
```

Sign in and change it immediately. If that log line has already rotated away,
see *Locked out* below.

## Adding people

Users are created by an administrator in the web interface: **Users → Add a
user**. There is no self-registration, and no password reset by email — on an
isolated network there is no mail. An administrator sets a temporary password
and the person is asked to change it on first sign-in.

Every job is recorded against the account that ran it. **Users → View the audit
log** shows sign-ins, account changes and job submissions.

---

## Capacity

Total parallel work is `RUNNER_REPLICAS × RUNNER_CONCURRENCY`. Keep that at or
below the host's core count — image processing is CPU-bound, and oversubscribing
makes every job slower rather than getting more done.

```bash
# more workers
docker compose up -d --scale runner=4

# or persist it
sed -i 's/^RUNNER_REPLICAS=.*/RUNNER_REPLICAS=4/' .env && docker compose up -d
```

Upscaling and background removal are the slow operations: tens of seconds per
image on CPU, which is expected and is why the queue exists. If they dominate
your usage, give `inference` more threads (`INFERENCE_THREADS`) rather than more
runners — the runners are only waiting on it.

---

## Retention

Finished job files are deleted `RETENTION_HOURS` after the job completes
(default 2). A sweeper runs every 10 minutes and also removes orphaned
directories that have no database row, so a crash mid-upload cannot leave
images on disk indefinitely.

To change it:

```bash
sed -i 's/^RETENTION_HOURS=.*/RETENTION_HOURS=8/' .env
docker compose up -d
```

Retention is measured from job completion, not submission, so a job that queued
behind a long backlog still gets its full download window.

---

## Backups

The only irreplaceable state is the database — accounts and the audit log. Job
files are ephemeral by design and do not need backing up.

```bash
# Consistent copy of the database (SQLite is in WAL mode; use its own backup)
docker compose exec api node -e "\
  const db=require('better-sqlite3')('/data/pixelsmith.sqlite',{readonly:true});\
  db.backup('/data/backup.sqlite').then(()=>console.log('ok'))"

docker compose cp api:/data/backup.sqlite ./pixelsmith-$(date +%F).sqlite
```

Store that file wherever your other sensitive backups go. It contains password
hashes (Argon2id) and the audit trail.

---

## Upgrading

1. Build a new bundle on the connected machine.
2. Copy it to the server.
3. Stop the old stack: `docker compose down`.
4. Run the new bundle's `./install.sh` — it will reuse the existing `.env` and
   the existing volumes, so accounts and history survive.

Schema migrations run automatically when the API starts. The runners
deliberately do **not** migrate: one process owns the schema, so there is no
race between replicas at startup.

Roll back by loading the previous bundle's images and starting it again. Keep
the previous bundle until you are satisfied with the new one.

---

## Locked out

**Forgot the admin password, no other admin account.** There is no email reset.
Promote a user, or reset a password, directly:

```bash
# List accounts
docker compose exec api node -e "\
  const db=require('better-sqlite3')('/data/pixelsmith.sqlite');\
  console.table(db.prepare('select email, role, is_active from users').all())"
```

To set a known password for an account, use the API container's own hashing so
the stored value is a valid Argon2id hash:

```bash
docker compose exec api node -e "\
  const {hash}=require('@node-rs/argon2');\
  const db=require('better-sqlite3')('/data/pixelsmith.sqlite');\
  hash(process.argv[1],{memoryCost:19456,timeCost:2,parallelism:1}).then(h=>{\
    db.prepare('update users set password_hash=?, must_change_password=1, failed_login_count=0, locked_until=null where email=?')\
      .run(h, process.argv[2]);\
    console.log('reset');\
  })" 'a-new-long-password' 'admin@pixelsmith.local'
```

Then sign in and change it through the interface. Doing this leaves no audit
entry, which is itself worth noting in your own records.

**Account locked after failed attempts.** Locks expire on their own after 15
minutes. An administrator can also disable and re-enable the account, which
clears the lock and ends its sessions.

---

## Diagnosing a failure

Jobs record their own failures. The user sees the reason on the job page, and
the code is one of:

| Code | Meaning | What to do |
|---|---|---|
| `unsupported_input` | Not an image, or a format we do not accept | Nothing; the upload was wrong |
| `malformed_image` | Truncated or corrupt file | Ask for a re-export |
| `unsafe_svg` | SVG contained a script, entity or external reference | Refused deliberately; see below |
| `limit_exceeded` | Too large, too many pixels, or too many frames | Raise limits in `.env` if legitimate |
| `invalid_params` | Options did not validate | A UI bug worth reporting |
| `inference_unavailable` | The sidecar is down or a model is missing | `docker compose logs inference` |
| `internal_error` | Anything unexpected | `docker compose logs runner` |

`unsafe_svg` is not a malfunction. SVG is a program, not a picture: a file with
a `DOCTYPE` entity can read files off the host, and an external reference makes
the renderer fetch a URL from inside your network. Those are refused rather than
sanitised, because rewriting XML reliably is harder than refusing it.

**Jobs stay queued forever.** The runners are not consuming. Check
`docker compose ps` and `docker compose logs runner`; the usual cause is Redis
being unreachable.

**HTML→image fails on a URL.** Expected unless you set `ALLOWED_RENDER_HOSTS`.
An empty allowlist refuses all URL rendering; pasted HTML always works.

---

## Giving it a language model

Some tools — summarising a document, for one — need a language model. Pixelsmith
talks to anything that speaks the OpenAI API, so a model you run yourself works:
vLLM, Ollama, llama.cpp. Configure it under **Settings → Language model**: a base
URL, a model name, and a key only if your endpoint wants one. The key is written
to `llm.json` in the data directory, readable only by the user the server runs
as, and never shown on the page again.

Those tools are not offered until a model has answered — a menu entry that always
fails is worse than one that is not there.

**The catch, and it is the whole of the difficulty.** The page is served by `api`
and the work is done by `runner`, and they are not on the same network. `runner`
has no route off this host at all, by design (see below). So a model on the host
machine, or anywhere else on your network, is reachable from `api` and *not* from
`runner` — and it is `runner` that has to reach it. The settings page reports the
two separately for exactly this reason, and only the workers' answer decides
whether the tools appear.

Three ways to give the workers a route, in the order worth trying:

1. **Run the model in the same Compose project**, on the `internal` network. It
   then needs no route off the host at all, and the air gap stays exactly as it
   is. This is the right answer for a machine that has a GPU.
2. **Put the workers on a network that reaches the model**, with an override
   file. This widens what the workers can reach, so decide deliberately:

   ```yaml
   # docker-compose.override.yml
   services:
     runner:
       networks: [internal, edge]
   ```

3. **Point at a model on another host** — then the workers need a route to it,
   which is case 2 plus firewall rules you write yourself.

Whichever you choose, the workers re-check every fifteen seconds and the pages
follow within ten, so a model that goes away takes its tools out of the menus on
its own, and brings them back when it returns. Nothing needs restarting.

---

## Confirming the air gap

Two different guarantees, and it is worth being precise about which is which.

**Guaranteed by construction.** Redis, the runners and the inference sidecar are
attached only to the `internal` network, declared `internal: true`. Docker gives
that network no NAT, so those containers have no route off the host regardless of
what the host itself can reach. Everything that opens your files — every image
operation, every PDF operation, every model — runs there.

**Depends on the host.** `api` is additionally attached to `edge`, because a
published port cannot be routed into an `internal: true` network. Its outbound
reachability is therefore whatever the host's is: on an air-gapped server, none.
If the host does have an upstream route and you want that closed too, block it in
the host firewall — the API never makes an outbound connection of its own.

To check it on the live deployment, using only what is already inside the images
(no image to pull, so this works on the isolated host):

```bash
# Pick a target you know answers. On a truly isolated network, nothing will,
# and the control below is what tells you the test is meaningful at all.
TARGET=1.1.1.1

# The processing tier: expect a timeout.
docker compose exec runner node -e "
const s=require('net').connect({host:'$TARGET',port:443,timeout:6000});
s.on('connect',()=>{console.log('CONNECTED - egress exists');process.exit(1)});
s.on('timeout',()=>{console.log('no egress (correct)');process.exit(0)});
s.on('error',e=>{console.log('no egress (correct):',e.code);process.exit(0)});"

# The model tier: expect a timeout.
docker compose exec inference python3 -c "
import socket,sys
s=socket.socket(); s.settimeout(6)
try: s.connect(('$TARGET',443)); print('CONNECTED - egress exists'); sys.exit(1)
except Exception as e: print('no egress (correct):', type(e).__name__)"
```

Run the same connect from the host first. If the host cannot reach the target
either, a timeout in the container proves nothing — you have measured a dead
target, not an air gap. Do not use `wget`/`curl` for this: neither is installed
in these images, so `wget ... || echo "no egress"` reports success because the
binary is missing.

Only `api` is published, and only on the address in `PUBLISH_ADDR`. The pages
themselves load no external resource: the Content-Security-Policy is
`default-src 'self'` with no exceptions, so a browser would refuse one even if a
page asked.

---

## What is deliberately not here

- **No TLS.** The stack serves plain HTTP on the loopback interface. Put your
  existing reverse proxy in front, and set `TRUST_PROXY=true` so the audit log
  records real client addresses instead of the proxy's.
- **No metrics endpoint or external monitoring.** Use `docker compose ps`,
  the healthchecks, and the logs.
- **No automatic upgrades.** Nothing reaches out, ever, including for updates.
