# MailDrop

Send a file that is far too big for an attachment — 2 GB, 20 GB, more — from a
plain web page, as a **single link** in a normal email. No account, no
subscription, no server of your own to write code for, nothing for the
recipient to install or open besides a link.

Open `index.html`, drop the file, copy the link, mail it. The recipient opens
the link, the page rebuilds the file in their browser, saves it, and tells them
whether the bytes match what you sent.

### Reading the page

The Send tab is three numbered steps and that is all you see:

| | |
|---|---|
| **1 · The file** | drop it, or click to browse. The sample button under it runs the whole pipeline with no network at all |
| **2 · Where it will sit** | one dropdown. Its one line of text tells you the size limit and the deletion schedule; expiry, part size and the password are inside a folded line underneath |
| **3 · Make the link** | the big button. Its label tells you what will happen, and the line under it says how many parts and when the host deletes them |

While it runs, the form is replaced by progress — bytes, rate, time left, and a
Stop button. When it finishes you get **one card**: the link, *Copy the link*,
*Copy the whole message*, and below that a folded email draft if you want the text
written for you. The Receive tab is one box: paste the link (or the whole email —
it digs the link out) and press *Open it*. Settings is optional for everything
except your own bucket.

```
your browser ──split──▶ parts ──▶ a file host (litterbox.catbox.moe, or your own bucket)
      │                                                    │
      └── one short link ──▶ email ──▶ their browser ◀─────┘  (reassemble + verify)
```

* **Static files only.** `index.html` plus `lib/*.js`. GitHub Pages, Netlify,
  an S3 bucket website, a folder on a USB stick — anywhere that serves files.
* **Nothing is uploaded to us.** There is no "us". See [docs/PRIVACY.md](docs/PRIVACY.md).
* **The file never rides inside the email.** Attachments cap out around
  10–25 MB per message (Gmail 25, Outlook 20, corporate Exchange often 10) and
  Base64 inflates the payload by a third, so ~18 MB is the practical ceiling.
  2 GB by attachment is not a thing anyone can fix with a cleverer page.
* **The link carries the manifest, not a session.** All the metadata lives in
  the URL hash as base32 (see *How the link works*), so the page that receives it
  needs no database and no backend.

---

## What it actually does

| | |
|---|---|
| Files up to ~1 GB | one part, one link, done |
| 1 GB – 20 GB | split into provider-sized parts, **one** link that stitches them back |
| over 20 GB | allowed, but only with your own bucket (see below) |
| many files at once | refused on purpose — zip them, the manifest stays tiny |
| optional password | off by default; when set, the host only ever sees ciphertext |

The Send tab is three numbered steps and nothing else until you need them: **1**
the file, **2** where it will sit, **3** the button. Expiry, part size and the
password sit in one folded line under step 2, and Settings is entirely optional.

**Send.** Pick a file, pick a provider, press the button. The page reads the
file in slices, uploads them in parallel with progress and retries, then shows the
link, the length, and a pre-written email you can copy or hand to your mail client.

**Receive.** Open the link. The part map comes out of the hash, the parts download
in parallel, each one is hashed and compared with the 16-hex-character fingerprint
the sender recorded, and the file is written to disk as it arrives. In Chromium
over HTTPS that is a real stream: the page asks for a file with *Save as*, writes
each part as it lands and never holds more than one in memory, so a 20 GB receive
works on a small laptop. Firefox and Safari have no `showSaveFilePicker`, so there
the parts accumulate in a `Blob` — fine up to a few gigabytes, and the page says
which mode it is in via the badges at the top. Then *Download & save file*.

**Verify.** Every part is checked. A truncated, replaced or expired part is
refused with a message that says which one and why — you never get a silently
broken file. And if the link carries no fingerprints at all, the page says *nothing
was checked* rather than smiling.

**Memory.** Nothing bigger than one 16 MiB window is ever held: the sender folds
digests as it reads, the receiver hashes, decrypts and writes in the same stream,
and each encrypted record (`32 MiB + 16`) is fetched whole and dropped at once. A
950 MiB part is 950 MiB of RAM in the naive design, which is how a big download
kills a tab — so `npm run stress` pushes **5 GiB** through the actual page on a
2 GB machine and fails if the file comes back changed.

---

## Providers

Chosen in the dropdown, described in the panel, tested for real in
[docs/PROVIDERS.md](docs/PROVIDERS.md):

| Provider | Per part | Keeps | Notes |
|---|---|---|---|
| **Litterbox** (default) | 950 MiB | 1 h / 12 h / 24 h / 72 h | no signup, browser-friendly CORS, range requests. A public host: treat the link as the secret. |
| **Your own bucket** | 4 GiB | you decide | Backblaze B2 or Cloudflare R2 free tier is enough for most people (10 GB). The browser signs requests itself and PUTs straight to the bucket. Needed for >20 GB, long retention, or keeping the file out of a stranger's hands. [Setup →](docs/SETUP-BUCKET.md) |
| **A link I already have** | n/a | whatever that host does | No upload. Paste a URL from any host (or a network share) and MailDrop writes the email and the receive page for it. |
| **In-page test** | 512 MiB | until you close the tab | No network at all. Good for watching the pipeline work before trusting a host. |

There is no paid plan because there is nobody behind this.

---

## How the link works

```
https://you.github.io/maildrop/#AERHAIR767TG3P6B…
                                    └─ base32(UTF-8 JSON manifest), no padding
```

Two fingerprints are in play. `parts[].h` is a folded digest (`SHA-256` of the
`SHA-256`s of 16 MiB windows) of the bytes *as stored*, and `h` is either the same
fold over the whole file or — above 8 GiB, where a second full read would make you
wait — the digest of the part digests, marked `hm:"parts"`. Both ends recompute
them from the same windows, which is what makes verification cheap enough to always
run.

The manifest is deliberately tiny and looks like this:

```json
{ "v":1, "n":"clip.mov", "t":"video/quicktime", "z":2147483648,
  "p":"litterbox", "b":"https://litter.catbox.moe/{id}",
  "d":259200000, "h":"9f2c1a…", "u":"https://litter.catbox.moe/ab12cd.mov",
  "parts":[{ "x":0, "i":"ab12cd.mov", "s":996147200, "h":"1a2b3c4d5e6f7890" }] }
```

* `z` is the size of the **original** file, `parts[].s` the size stored on the host —
  with a password those differ, and the difference is exactly the AES-GCM tags.
* `b` is a URL *template*: the same bucket, one id per part. That is what keeps a
  20-part transfer to ~600 characters instead of 4 KB.
* The hash never reaches a web server, never appears in a `Referer`, and is not
  logged by anything between you and the page.
* Base32 (`A–Z2–7`) because mail clients soft-wrap URLs and quote-printable
  encoders happily eat `-` and `=`. The receive box also accepts the whole email
  body and digs the link out of it (`MD.manifest.findManifest`).
* Budget is 6200 characters of token, and the length is **measured, not guessed**:
  before the first byte leaves the machine the page encodes a trial manifest of the
  shape this job would produce and counts the characters. If the user's part size
  would blow the budget, the parts are grown until it does not (5 GiB at a 64 MiB
  cap becomes 40 parts of 128 MiB) and the plan box says so. If not even the host's
  own maximum can fit, the file is refused before anything is uploaded — a two-
  minute upload ending in "the link is too long" is the worst possible failure.

**Two GB in, one link out.** If a mail client or a spam filter refuses the long
link, the link card has a folded *Backup* section with one short link per part —
send those as separate emails and the receive page merges them into one job.

**An attempt that stops is not a restart.** Parts already on the host are kept and
reused: if a 28-part job dies at part 20, the next Start sends 8 and re-records the
20 it cannot see, and the plan box tells you that is what will happen. For an
encrypted job the record carries the salt and IV prefix (never the password), which
is what lets the already-sealed parts join the new ones — and a *different* password
on the retry is refused rather than mixed in. On your own bucket, **Cancel** or
**Start over** deletes the stored parts; a free host has no delete API, so those
age out on its clock. `MD.config.rememberAttempts = false` turns the record off.

---

## Password (optional, off by default)

Tick *Add a password* and the file is encrypted in the page before it leaves:

* PBKDF2-SHA256, 210 000 iterations → 512 bits; the low half becomes a
  non-extractable AES-GCM-256 key, the high half's first 12 hex characters go in
  the manifest as a verifier, so a wrong password is rejected before any
  decrypting starts.
* Encrypting happens in fixed records (`32 MiB − 16` by default, changeable in
  Settings); the record size travels in the manifest so the recipient reads it
  identically. The IV is a random 4-byte prefix plus an 8-byte big-endian record
  index, continuous across parts, so no IV is ever reused.
* Per-part fingerprints are taken on the **ciphertext**, so the host cannot learn
  anything from them.
* There is no recovery. A forgotten password means the file is gone.

The threat model, the guards and the tests that pin them are written up in
[docs/SECURITY.md](docs/SECURITY.md) — including why the URL in someone else's
email is attacker input and what the fingerprints can and cannot prove.

The default stays "no crypto, dead simple" because that is what this page is for:
a public host plus no encryption means **anyone who gets the link can read the
file**. If the link might travel somewhere you don't control, tick the box.

---

## Try it now

```bash
npm run serve        # node tools/serve.mjs — no dependencies, nothing to install
# → http://127.0.0.1:8080/
```

Double-clicking `index.html` works for the demo too; only the cross-origin parts
(a real provider, the `fetch` on the receive side) want an `http://` URL.

Then choose **In-page test** as the provider and press *Demo* — a 4 MB sample file
goes through the real pipeline (hash, split, upload, link, receive, verify) with
zero network.

> Opening `index.html` from the filesystem works for sending to the in-page test
> backend; anything that needs `fetch` across origins wants a real `http://` URL.

## Run the tests

```bash
npm install            # jsdom only, and only for the browser test
npm test               # unit + integration + browser + page, 71 tests
npm run test:browser   # any one suite on its own
npm run live           # node tools/live-check.mjs — pokes the real public hosts
```

* `tests/unit.test.js` — manifest round trips, packing, crypto, email recovery.
* `tests/integration.test.js` — real uploads against `tools/mock-host.mjs`.
* `tests/browser.test.js` — the actual page, all ten scripts, in jsdom, clicked
  like a user: pick → send → link → receive → byte-identical file, plus the
  password, split, corrupted-part and bring-your-own-link paths.
* `tests/page.test.js` — the HTML itself: ids the scripts rely on, no stray
  third-party requests, script order, and every `<script src>` and doc link
  fetched from a real static server (`tools/serve.mjs`) to prove the deployed
  shape has nothing missing.
* `tools/stress-5gb.mjs` — not part of `npm test` (it needs 10 GB of disk and a few
  minutes): 5 GiB of dummy bytes through the real page, up and back, with the
  result hashed independently, and the RSS curve printed while it goes so a leak is
  visible rather than inferred from a crash. `--gb`, `--part`, `--password`,
  `--send-only`, `--receive-only` and `--keep` are yours; `--resume-check` refuses
  one part on purpose and fails if the second attempt re-sends what the host still
  has.

The mock host is deliberately as strict about multipart framing as a real PHP
endpoint, because a missing CRLF before the closing boundary once produced
"the file field is required" from a live provider while every local test passed.

## Deploy

Ten minutes, no build step, no server code:
[docs/DEPLOY-GITHUB.md](docs/DEPLOY-GITHUB.md).

## Layout

```
index.html          the whole UI: three tabs, styles inline, no build step
lib/util.js         formatting, base32, hashing, tiny helpers
lib/manifest.js     the link: encode/decode/merge/rescue
lib/crypto.js       PBKDF2 + AES-GCM in fixed records
lib/pack.js         part plan, multipart bodies, retry, rate
lib/backends.js     litterbox / bucket / bring-your-own-link / in-page test
lib/receive.js      download, verify, stitch, write to disk
lib/email.js        subject, body, mailto:
lib/ui.js           every DOM read and write
lib/app.js          the two flows and the settings that drive them
lib/config.js       optional pre-configuration for a shared deployment (bucket, part
                    size, and the three behaviour knobs: stall seconds, upload
                    attempts, in-memory ceiling)
tools/              mock host (tests) and a live provider check
tests/              four suites + a harness
```

There is no bundler, no framework and no `dist/`. What you read is what runs.
