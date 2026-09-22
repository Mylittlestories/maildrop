# Deploying MailDrop to GitHub Pages (or anywhere else)

The whole app is `index.html` plus ten files in `lib/`. There is no build step,
no dependency, no `dist/` — if the files are served, the app works.

## GitHub Pages — about ten minutes

1. **Make the repo**
   <https://github.com/new> → name it `maildrop`. *Add a README* can be unticked,
   we bring our own. Keep it **public** if you want the free Pages URL; a private
   repo also works with Pages on the free plan, but then anyone with the link needs
   GitHub access, which defeats the point.

2. **Push from this folder**
   ```bash
   cd maildrop
   git init -b main
   git add .
   git commit -m "MailDrop: link-based large-file transfer, static"
   git remote add origin https://github.com/<you>/maildrop.git
   git push -u origin main
   ```
   (Already done in this copy if `.git` exists — then just `git push`.)

3. **Turn Pages on**
   Repo → *Settings* → *Pages* → **Source: Deploy from a branch** →
   branch `main`, folder `/ (root)` → *Save*.

4. **`.nojekyll` matters.** It is in this repo. Without it, Jekyll runs over the
   tree, and a file or folder starting with an underscore disappears from the
   published site. Leave that file alone.

5. **Wait ~1 minute**, then open
   `https://<you>.github.io/maildrop/` and press *Demo* on the Send tab. It should
   hand you a link that round-trips a 4 MB file with no network at all.

6. **Set the receive base** (only if the page is not at the root of the domain)
   Settings → *Receive page base* → `https://<you>.github.io/maildrop/`.
   The link the app builds takes its origin from the page it is running on, so this
   only needs touching when you alias or mirror the site.

7. **Send yourself something** through a real provider (Litterbox) to confirm the
   host accepts uploads from your new origin. If it does not, `node
   tools/live-check.mjs 20` from any machine tells you whether the host or the
   network is at fault.

## Other ways to serve it — pick any

| Where | How | Watch out for |
|---|---|---|
| Netlify / Cloudflare Pages | drop the folder, no build command | same as Pages; set the site URL as receive base if you rename it |
| A bucket (S3/R2/B2) website | upload the tree, allow `GetObject` publicly, no listing | the bucket *is* then also your storage; set CORS on it as in [SETUP-BUCKET.md](SETUP-BUCKET.md) |
| Your own web server / nginx / Apache | `cp -r` the folder into the docroot | needs HTTPS for WebCrypto |
| An internal share, opened as files | not really — `file://` blocks cross-origin fetch | use the *in-page test* backend for demos |

## HTTPS is not optional-ish

`crypto.subtle` (hashing, and the optional password) exists only in a secure
context. `http://` on a laptop works for testing because `localhost`/`127.0.0.1`
count as secure, but plain `http://192.168.1.20/` does not, and the page will say
so in the context badges rather than fail confusingly. Use the GitHub Pages
`https://` URL and there is nothing to think about.

## The CSP header this page ships with

`index.html` carries

```html
<meta http-equiv="Content-Security-Policy"
      content="script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
```

It is what makes "a manifest from someone else's email" survivable: even if a future
change forgot a URL check, a `javascript:` payload cannot execute, because no
script that is not one of this folder's ten files is allowed to run. Two
consequences if you edit the page: **do not add inline `<script>` blocks or
`onclick=` attributes** (add a file in `lib/` instead), and if you serve the page
with your own CSP header, keep `script-src 'self'` — the app needs no other
script source. Styles stay inline on purpose, so `style-src` is deliberately not
restricted; `connect-src` must stay open because the whole design is "fetch from
whatever host the sender chose".

## Updating

Edit, `git push`, wait ~30 s. Because the app is stateless — everything about a
transfer is in the link the sender already pasted into an email — an old link keeps
working after you deploy a new version, as long as `lib/manifest.js` still
understands its version byte. Do not change the manifest fields without bumping
`v` and keeping the decoder able to read the previous shape.

## What you are committing (and what you are not)

Nothing secret needs to be in the repo: the settings live in `localStorage` of the
browser you typed them into. The one thing that must **never** be committed is a
bucket secret key — if you want config in the repo, put your key id in
`lib/config.js` (optional, the page loads it if present) and keep the secret out.

```js
// lib/config.js — optional, plain file, no secrets
MD.config = {
  s3: { endpoint: 's3.eu-central-003.backblazeb2.com', bucket: 'mail', region: 'eu-central-003',
        keyId: '004xxxxxxxxxxxx', keyPrefix: 'drop/' }
};
```

`lib/config.js` ships with every key commented out, so it costs nothing to leave
it alone. Values there are only a starting point: anything a browser has already
saved in Settings beats the file, and the *Wipe* button in Settings puts you back
on it. The secret key still has to be typed once per browser.
