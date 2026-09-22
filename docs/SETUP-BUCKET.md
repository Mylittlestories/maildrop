# Your own bucket (the option that makes big files comfortable)

Litterbox is fine for a one-off. A bucket is better when the file is bigger than
about 15 GB, when it must stay reachable for weeks, or when you would rather the
bytes were not sitting on a stranger's server with a guessable link. It is not a
server: it is storage with an HTTPS API, and this page talks to it directly.

**Cost, realistically:** Backblaze B2 gives 10 GB free. Cloudflare R2 gives 10 GB
free and charges nothing for downloads, which is the part that hurts elsewhere.
Both are enough to send a few tens of gigabytes a month and never look at a bill.

## 1. Backblaze B2 (about five minutes)

1. <https://www.backblaze.com/> → sign up (card not required for the free tier in
   most regions; if it asks, the free 10 GB stays free).
2. *Buckets* → **Add a Bucket** → name it `maildrop-files`, region anything near
   you, **Covering private buckets** is fine — we do not need public read.
3. Bucket → *Settings* → **CORS Rules** → paste:
   ```json
   [
     {
       "corsRuleName": "maildrop",
       "allowedOrigins": ["https://<you>.github.io"],
       "allowedHeaders": ["*"],
       "allowedOperations": ["s3_put", "s3_get", "s3_head"],
       "exposeHeaders": ["etag", "content-length"]
     }
   ]
   ```
   Add a second entry with `"*"` as the origin while you test, then tighten it.
   *`s3_put` is the one people forget: without it the browser sends the file and
   the bucket answers 403 with no useful message.*
4. Bucket → *Settings* → **Lifecycle Rules**: files auto-delete after *n* days.
   This is how "expires in 3 days" happens on your own bucket — MailDrop tells the
   recipient the expiry from the same number, so keep them in step.
5. *App Keys* → **Copy Key ID** and **Application Key** (paste it into a
   password manager; B2 shows the secret once).
6. *Buckets* → the bucket page shows **Endpoint** (e.g.
   `s3.eu-central-003.backblazeb2.com`) and **Region** (`eu-central-003`).

## 2. Cloudflare R2

1. Dashboard → *R2 Object Storage* → **Create bucket** → `maildrop-files`.
2. *Manage Development API Tokens* (R2 → *API*) → **Create API Token** →
   *Object Read & Write* → scoped to that bucket → **Access Key ID** and
   **Secret Access Key**.
3. Settings → *CORS policy* → `AllowedMethods: PUT, GET, HEAD`,
   `AllowedOrigins: https://<you>.github.io`, `AllowedHeaders: *`.
4. Endpoint: `https://<account-id>.s3.r2.cloudflarestorage.com`, region `auto`.
5. Expiry: R2 has no lifecycle rule on the free plan, so set **Default expiry** in
   MailDrop to *no expiry setting* (the page then tells the recipient nothing about
   a deadline) and tidy the prefix yourself when you are done — the history on the
   Send tab lists every link you made, and the object name is in it.

## 3. Fill the form

Open the MailDrop page → **Settings**, provider *Self-hosted bucket*:

| Field | B2 example | Notes |
|---|---|---|
| Endpoint URL | `https://s3.eu-central-003.backblazeb2.com` | bare host is fine too, `https://` is added |
| Bucket | `maildrop-files` | |
| Region | `eu-central-003` | R2: `auto` |
| Key prefix | `maildrop/` | everything MailDrop writes lands under it |
| Key ID | `004abc…` | |
| Application key / secret | `K003xyz…` | **stays in this browser** — see below |
| Public base URL | *(blank)* | only if you put a CDN or a custom domain in front |
| Presigned URL lifetime (s) | `86400` | one fresh URL per part, built when the recipient clicks |

Two buttons sit under that form and they are worth pressing in order:

* **Check the config (signs a URL)** — offline: proves the fields are complete and
  that the signature code agrees with them. No request leaves the page.
* **…and really upload 1 byte** — one actual PUT plus a ranged GET against your
  bucket, then a delete. That is the one that catches a missing `s3_put` CORS
  rule, a wrong region, or a key without write access. Far better than guessing
  from a 403 mid-transfer.

## Where the secret lives, and what that means

The secret key is in the settings object this page keeps in `localStorage`, on the
machine you typed it into. Nothing sends it anywhere except as an AWS4 signature
header to your endpoint (which is signed with HMAC-SHA256, so the key itself is not
on the wire). Consequences worth stating out loud:

* Anyone with that machine, or with the profile on it, can read it. On a shared or
  work computer: use Litterbox, or wipe the settings (Settings → *Wipe this
  browser*) when you are done.
* Give the key **only** `ObjectRead`/`ObjectWrite` on that one bucket and nothing
  else. Both providers support scoped keys, and a scoped key makes the whole
  "leaked key" conversation short.
* A key can be deleted and replaced in about ten seconds on either dashboard. If
  you suspect it leaked, do that first and retype it here.
* If you want the endpoint/bucket/key-id pre-filled for a team, put them in
  `lib/config.js`. The secret never goes there — that file is published with the
  site.

## Multipart, in one paragraph

MailDrop PUTs each part as its own object and presigns one URL per part, which is
why a 4 GiB part is fine while S3's single-PUT ceiling is 5 GB. It does **not**
use S3's own multipart upload API: that needs a `POST` with an XML body and CORS
rules most buckets don't have open, and the result is one object the recipient's
browser must then range-read. N small objects, each independently verifiable and
resumable, is a better fit for a page like this — a part that fails retries
uploads only that part.
