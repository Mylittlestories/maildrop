# Providers, and why the list is this short

Sending a big file from a browser needs a host that satisfies four things at once.
Most do not, and it took measuring to find out which do:

1. accepts a **`POST` from another origin** (i.e. `Access-Control-Allow-Origin` on
   the upload endpoint, and no preflight-tripping headers required);
2. serves the stored bytes back with **CORS on the download**, so the receive page
   can read them;
3. supports **`Range`** requests, so a 20 GB file can be stitched from parts and a
   dropped connection can resume instead of restarting;
4. has a **size limit per upload** that is not 100 MB, and no login.

`node tools/live-check.mjs 20` runs those checks against the live hosts and prints
what it found. Run it before blaming the app when a send fails.

## Measured (September 2026, from a datacenter IP)

| Host | Upload from a browser | Download readable by a page | Verdict |
|---|---|---|---|
| **Litterbox** `litterbox.catbox.moe` (from a datacenter IP: 403) | `POST /resources/internals/api.php`, multipart, CORS `*` | `litter.catbox.moe/<id>`, `access-control-allow-origin: *`, `accept-ranges: bytes`, exact `content-length`. 950 MiB per upload, 72 h max. | **Kept as the default.** The only no-signup host found that satisfies all four. Note the 403: the WAF in front of the upload endpoint refuses some datacenter/VPN ranges outright — `ACAO: *` is still on the reply, so the CORS story is intact and the same request from a home connection works. If `live-check` shows exactly that, it is the network, not the page. |
| **tmpfiles.org** | accepts the upload and returns JSON | the file URL answers `200 text/html` — a landing page, 2 806 bytes, not the 6 MiB stored. `/dl/` `302`s to the same page. | **Removed.** A page cannot fetch what the host will only serve to a human click. The link is still fine for a person, so use *A link I already have*. |
| **tmpfile.link** | accepts multipart, JSON reply | raw bytes, exact `content-length` ✓, but **no** `access-control-allow-origin` | download blocked by the browser. Same treatment: bring-your-own-link. |
| **x0.at** | plain multipart, replies with a bare URL | raw bytes ✓, no CORS header | same. |
| **catbox.moe** | OPTIONS → `412`, no CORS headers | fine for humans | cannot be driven from a page. |
| **uguu.se / tempfile.org** | endpoint shape not reachable from a browser | — | skipped; both cap at ~100 MB anyway. |
| **your bucket (B2 / R2 / Wasabi / MinIO)** | you set the CORS rule, so yes: `PUT` with `SignedHeaders=host` and everything else in the query string is a *simple* request — no preflight | ranged `GET` on a presigned URL ✓ | 4 GiB per part, any retention, ~$0 at the sizes a person emails. |

Two of those rows are the whole reason the app has a *bring-your-own-link* mode and
a fallback button on the receive page: "the host will only serve a human click" is
the most common property of free file hosts, and a page like this should degrade to
it gracefully instead of pretending the file is broken.

## Why Litterbox and not something permanent

`files.catbox.moe` keeps files forever, which is exactly what you do **not** want
for a link you emailed: permanent storage of something you meant to be temporary,
indexed by people who scrape those URLs. A 72-hour clock is a feature. The hosts
that advertise "no account, huge limit, long retention" are also the ones that
change the rules within a year — see the two dead providers in the table above.

The practical limits that fall out of this:

| | Litterbox | Your bucket |
|---|---|---|
| per part | 950 MiB | 4 GiB |
| total, one link | ~20 GB (the token budget) | as many parts as you like, ~19 TB |
| retention | 1–72 h | you decide, with a lifecycle rule |
| cost | 0 | 0 up to 10 GB on B2/R2 free tiers |
| who can read it | anyone with the link (unless you set a password) | anyone with the link (same), but the link is not on a public host's index |

## The 25 MB attachment ceiling, for reference

Measured limits people keep re-testing: Gmail 25 MB, Outlook.com 20 MB, Yahoo 25
MB, iCloud Mail 20 MB, corporate Exchange often 10 MB — and Base64 inside the
`Content-Transfer-Encoding` inflates the file by about a third, which is why the
real-world ceiling is nearer 18 MB. Any service that claims to send 2 GB "by
email" is not putting the file in the email; it is putting a link in the email,
which is precisely what this page does, without the account and the upsell.

## Adding a provider

It is one object in `lib/backends.js`. A provider needs:

```js
{
  key: 'example',
  label: 'Example host — no signup',
  blurb: 'one honest sentence about what it does with your bytes',
  maxPartBytes: 512 * 1024 * 1024,
  expiries: [{ v: '1h', ms: 3600000 }],
  defaultExpiry: '1h',
  // extra form fields sent next to the file; litterbox needs these to exist
  fieldsFor: function (expiry) { return { reqtype: 'fileupload', time: expiry || this.defaultExpiry }; },
  // `body` is already in the shape this endpoint wants: app.js wraps the part in
  // a multipart form when MD.backends.wantsForm(this) is true, and hands over raw
  // bytes otherwise. You only deal with the request.
  upload: async function (body, opts) {
    var res = await xhrUpload('https://example.com/api/upload', body, {
      method: 'POST', label: 'example.com',
      onProgress: opts.onProgress, signal: opts.signal
    });
    if (res.status !== 200) throw new Error('example.com said ' + res.status + ': ' + U.truncateUtf8(res.text, 160));
    return MD.pack.urlToTemplate(JSON.parse(res.text).data.url);   // -> { id, base }
  },
  buildUrl: function (id, base) { return MD.pack.templateToUrl(base, id); }
}
```

`MD.pack.urlToTemplate(url)` turns `https://h/f/ab12.bin` into
`{ base: 'https://h/f/{id}', id: 'ab12.bin' }` so nine parts share one prefix in the
manifest instead of nine near-identical URLs — that trick is most of why the link is
short. If a host returns a URL whose *only* difference per part is the id, you get
that for free.

A new provider also needs `MD.backends.selfhostConfigured`-style validity checks if
it has user-set fields, otherwise leave `fieldsFor` returning `{}` and the panel
shows nothing extra.

Then add it to `list` and `byKey`, and write one test in
`tests/integration.test.js` that uploads through `tools/mock-host.mjs` shaped like
your endpoint. The mock host refuses a multipart body whose closing boundary is not
preceded by `CRLF`, which is what a strict PHP endpoint does — keep that behaviour,
it has already caught one real bug here.

If the host will not send CORS headers, set `noUpload`-style handling instead: put
it in *A link I already have* and it works for humans today with no code at all.
