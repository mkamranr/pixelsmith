# REST API

Every tool the web pages use is available over HTTP — images and PDFs alike.
Nothing here talks to the outside world: the API is the same server, on the same
machine, as the pages. A live copy of this reference, generated from the running
registry, is at `/api/docs`.

- [Getting in](#getting-in)
- [Endpoints](#endpoints)
- [Creating a job](#creating-a-job)
- [Following it](#following-it)
- [Taking the results](#taking-the-results)
- [Chaining one job into the next](#chaining-one-job-into-the-next)
- [Errors](#errors)
- [Tool reference](#tool-reference)
- [Worked example](#worked-example)

## Getting in

With `AUTH_MODE=open` (the default) no credentials are needed to create a job.
With accounts enabled, sign in first and keep the session cookie; an
unauthenticated call is answered `401` with a JSON body.

Identity still matters after that, because **a job belongs to whoever created it
and is nobody else's to read**. Creating one answers with a `token`; send it back
as `X-Job-Token` on the calls that read the job, its progress or its files.

```
POST /api/jobs                      → 202 { id, token, statusUrl, … }
GET  /api/jobs/{id}                 + X-Job-Token: <token>
GET  /jobs/{id}/files/{fileId}      + X-Job-Token: <token>
```

A browser needs no token, having been given a cookie. A script has no cookie
jar — and without either, reading your own job is answered `404`, exactly like
anyone else's.

The token is the job's only protection, so treat it as one. It goes in a header
rather than the URL, because URLs end up in logs, proxies and browser history.

> `GET /api/jobs/{id}/events` is the one exception: a browser's `EventSource`
> cannot set headers, so that endpoint relies on the cookie. From a script, poll
> `GET /api/jobs/{id}` instead.

There is no API-key mechanism. The table exists in the database but nothing
issues or verifies keys — worth knowing before you write a client around it.
Per-job tokens are not a substitute: they authorise one job, not a caller.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness, and which queue driver is active |
| `GET` | `/api/tools` | Every tool: family, what it accepts, its parameters |
| `GET` | `/api/tools/{id}` | One tool's parameters in detail |
| `POST` | `/api/jobs` | Create a job. Multipart. Answers `202` |
| `GET` | `/api/jobs/{id}` | Status, and the outputs once it is done |
| `GET` | `/api/jobs/{id}/events` | Progress as server-sent events |
| `GET` | `/jobs/{id}/files/{fileId}` | Download one result |
| `GET` | `/jobs/{id}/download` | Download every result as a zip |

## Creating a job

One multipart request. `tool` names the tool, `files` carries the inputs, and
every other field is one of that tool's parameters. No CSRF token is required —
a script has no page to take one from.

```bash
curl -sS -X POST http://localhost:8080/api/jobs \
  -F "tool=resize" \
  -F "files=@one.jpg" -F "files=@two.jpg" \
  -F "mode=pixels" -F "width=1600"
```

```json
{
  "id": "3f0c…",
  "tool": "resize",
  "status": "queued",
  "statusUrl": "/api/jobs/3f0c…",
  "eventsUrl": "/api/jobs/3f0c…/events",
  "token": "PWq1_IEU…"
}
```

Notes that save time:

- **Repeat `files` once per input.** Order is preserved, and tools that care
  about order (merge, images to PDF) use it.
- **Supporting files go in their own field.** A signature image, a watermark
  picture: the field name is in `GET /api/tools/{id}`, not `files`.
- **Some tools take no files at all.** `html-to-image` and `html-to-pdf` build
  their input from parameters; `GET /api/tools/{id}` reports
  `"inputMode": "none"`.
- **Parameters are validated before the job is queued**, so a bad value is a
  `400` you get immediately rather than a failure you discover later.
- **Uploads are identified by their contents**, not their filename or declared
  type. A `.png` holding JPEG data is treated as JPEG; a file no tool can read
  is refused `415`.

## Following it

Poll the status:

```bash
curl -sS -H "X-Job-Token: $TOKEN" http://localhost:8080/api/jobs/$JOB
```

```json
{
  "id": "3f0c…",
  "tool": "resize",
  "status": "done",
  "progress": 100,
  "error": null,
  "createdAt": 1787865159806,
  "finishedAt": 1787865161233,
  "expiresAt": 1787872361233,
  "outputs": [
    { "id": "ea63…", "name": "one.jpg", "mime": "image/jpeg", "bytes": 184213,
      "url": "/jobs/3f0c…/files/ea63…" }
  ]
}
```

`status` is one of `queued`, `running`, `done`, `failed`, `expired` or
`cancelled`. On failure, `error` carries a `code` and a `message` written to be
read by a person.

## Taking the results

```bash
# One file
curl -sS -H "X-Job-Token: $TOKEN" "http://localhost:8080$URL" -o result.jpg

# Everything, as a zip built streaming
curl -sS -H "X-Job-Token: $TOKEN" \
  "http://localhost:8080/jobs/$JOB/download" -o results.zip
```

**Results are temporary.** `expiresAt` says when the files are deleted —
`RETENTION_HOURS` after the job finished, two hours by default. A sweeper also
removes orphaned directories with no database row, so a crash cannot leave
uploads on disk indefinitely.

## Chaining one job into the next

The outputs of a finished job can be the inputs of the next one without
re-uploading, which matters for a batch of forty images.

```bash
curl -sS -X POST http://localhost:8080/api/jobs \
  -F "tool=watermark" -F "fromJob=$JOB" \
  -F "text=CONFIDENTIAL" -F "position=tiled"
```

Send `fromJob` instead of `files`. The source job must be one you can read — the
same rule as everywhere else, so a job id alone does not let you take somebody
else's output.

## Errors

Every failure is JSON: `{ "error": { "code": "…", "message": "…" } }`.

| Status | Code | Means |
|---|---|---|
| `400` | `invalid_params` | A parameter is missing, malformed or out of range |
| `400` | `bad_input` | The file is readable but not usable for this tool |
| `401` | `unauthorized` | Credentials are needed on this deployment |
| `404` | `not_found` | No such tool, or no such job *for you* |
| `413` | `payload_too_large` | Over `MAX_UPLOAD_BYTES` or `MAX_FILES_PER_JOB` |
| `415` | `unsupported_input` | Not a sort of file this tool reads |
| `422` | `unavailable` | The tool needs something this server has not got |
| `429` | `rate_limited` | Too many requests |
| `500` | `internal` | A bug. The response says so plainly |

A `404` on a job you just created almost always means the token is missing —
see [Getting in](#getting-in).

## Tool reference

`tool` is the value to send in the `tool` field. Parameters are the other
multipart fields.

### Image tools (12)

| `tool` | Name | Parameters |
|---|---|---|
| `blur-faces` | Blur faces | `method`, `strength`, `regions`, `detect`, `confidence` |
| `compress` | Compress images | `level`, `format`, `targetKb` |
| `convert` | Convert format | `to`, `quality`, `background` |
| `crop` | Crop images | `x`\*, `y`\*, `width`\*, `height`\* |
| `editor` | Photo editor | — |
| `html-to-image` | HTML to image | `source`, `html`, `url`, `width`, `height`, `fullPage`, `blockThirdParty`, `hideOverlays`, `deviceScale`, `format`, `selector` |
| `meme` | Meme generator | `top`, `bottom`, `uppercase`, `fontSize`, `color`, `strokeColor` |
| `remove-background` | Remove background | `model`, `background`, `feather` |
| `resize` | Resize images | `mode`, `width`, `height`, `percent`, `maintainAspect`, `noEnlarge` |
| `rotate` | Rotate & flip | `angle`, `flop`, `flip`, `background` |
| `upscale` | Upscale image | `scale` |
| `watermark` | Watermark images | `mark`, `text`, `markFile`, `markScale`, `x`, `y`, `position`, `tiled`, `color`, `opacity`, `fontSize` |

### PDF tools (29)

| `tool` | Name | Parameters |
|---|---|---|
| `compare-pdf` | Compare PDF | `title` |
| `edit-pdf` | Edit PDF | `items`\*, `image` |
| `fill-form` | Fill a PDF form | `values`\*, `flatten` |
| `html-to-pdf` | HTML to PDF | `source`, `html`, `url`, `pageSize`, `landscape`, `margin`, `printBackground`, `blockThirdParty`, `filename` |
| `images-to-pdf` | JPG to PDF | `pageSize`, `orientation`, `margin`, `filename` |
| `merge-pdf` | Merge PDF | `filename`, `rotations` |
| `ocr-pdf` | OCR PDF | `language`, `dpi` |
| `office-to-pdf` | Office to PDF | — |
| `organize-pdf` | Organise PDF | `plan`, `pages` |
| `pdf-compress` | Compress PDF | `mode`, `dpi`, `quality`, `grayscale` |
| `pdf-crop` | Crop PDF | `x`, `y`, `width`, `height`, `pages` |
| `pdf-page-numbers` | Add page numbers | `position`, `format`, `startAt`, `fontSize`, `margin`, `pages` |
| `pdf-protect` | Protect PDF | `password`\*, `allowPrinting`, `allowCopying` |
| `pdf-repair` | Repair PDF | — |
| `pdf-to-excel` | PDF to Excel | — |
| `pdf-to-image` | PDF to JPG | `format`, `dpi`, `quality`, `pages` |
| `pdf-to-markdown` | PDF to Markdown | `pageBreaks` |
| `pdf-to-powerpoint` | PDF to PowerPoint | — |
| `pdf-to-word` | PDF to Word | — |
| `pdf-unlock` | Unlock PDF | `password`\* |
| `pdf-watermark` | Watermark PDF | `text`\*, `tiled`, `opacity`, `color`, `fontSize`, `pages`, `x`, `y` |
| `redact-pdf` | Redact PDF | `findText`, `redactEmails`, `redactPhones`, `redactCards`, `regions`, `dpi` |
| `remove-pages` | Remove pages | `pages`\* |
| `rotate-pdf` | Rotate PDF | `angle`, `pages` |
| `scan-pdf` | Scan to PDF | `mode`, `enhance`, `trim`, `filename` |
| `sign-pdf` | Sign PDF | `kind`, `signatureFile`, `text`, `face`, `colour`, `caption`, `pages`, `width`, `x`, `y` |
| `split-pdf` | Split PDF | `mode`, `pages`, `ranges`, `every`, `maxMb`, `mergeAll` |
| `summarise-pdf` | Summarise PDF *(needs a language model)* | `length`, `language`, `focus` |
| `translate-pdf` | Translate PDF *(needs a language model)* | `language`\*, `keepOriginal` |

\* required — the request is refused without it. `GET /api/tools/{id}` gives each
parameter's kind, default and permitted values.


## Worked example

Merging two documents, start to finish, with no cookie jar:

```bash
HOST=http://localhost:8080

CREATED=$(curl -sS -X POST $HOST/api/jobs \
  -F "tool=merge-pdf" \
  -F "files=@first.pdf" -F "files=@second.pdf" \
  -F "filename=joined")
JOB=$(echo "$CREATED"  | jq -r .id)
TOKEN=$(echo "$CREATED" | jq -r .token)

until curl -sS -H "X-Job-Token: $TOKEN" "$HOST/api/jobs/$JOB" \
  | jq -e '.status == "done" or .status == "failed"' >/dev/null; do sleep 1; done

URL=$(curl -sS -H "X-Job-Token: $TOKEN" "$HOST/api/jobs/$JOB" | jq -r '.outputs[0].url')
curl -sS -H "X-Job-Token: $TOKEN" "$HOST$URL" -o joined.pdf
```

The same in Python:

```python
import time, requests

HOST = "http://localhost:8080"

created = requests.post(
    f"{HOST}/api/jobs",
    data={"tool": "merge-pdf", "filename": "joined"},
    files=[("files", open("first.pdf", "rb")), ("files", open("second.pdf", "rb"))],
).json()

headers = {"X-Job-Token": created["token"]}
while True:
    job = requests.get(f"{HOST}{created['statusUrl']}", headers=headers).json()
    if job["status"] in ("done", "failed"):
        break
    time.sleep(1)

if job["status"] == "failed":
    raise SystemExit(job["error"]["message"])

result = requests.get(f"{HOST}{job['outputs'][0]['url']}", headers=headers)
open("joined.pdf", "wb").write(result.content)
```
