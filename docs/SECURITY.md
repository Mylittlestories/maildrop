# Security notes — what is guarded, and what cannot be

Threat model for a static page whose whole state travels inside a link that
someone else may have written.

## The one interesting attack, and the fix

A recipient is sent a link. The part after the `#` is a manifest: file name, part
addresses, a fingerprint. Everything in it is **input from an attacker** as far as
the receiving page is concerned — a hostile link is trivially crafted, and the page
keeps useful things in `localStorage` (a bucket secret key, the history of what you
sent).

Three sinks used to take that input literally:

* the *Open it on the host* button (`<a href>` from `manifest.u`) — a
  `javascript:` address there is a one-click XSS;
* the part fetches (`fetch(manifest.b + manifest.parts[].i)`) — `data:`, `file:`,
  or an id of `../../other-tenant/secret` turn the recipient's browser into a
  proxy for whoever built the link;
* the file name, which is rendered as text and *was* inserted into markup in one
  place.

Now: **one gate, at the only door.** `MD.manifest.canonical()` calls `guardUrls()`,
and both `encode()` and `decode()` go through it — so the receive page, the
history re-open, the preview button and the direct-link anchor all inherit it. A
manifest that names anything but `http(s)` (plus `local://` for the in-page test
backend) is refused with an explicit error, and a part id may not contain a slash,
a dot-dot, a query, a fragment, whitespace or quotes. `MD.util.cleanName` strips
`< > " ' \`` as well as slashes and control characters, so a name cannot become
markup anywhere it is shown. The direct anchor carries `rel="noopener noreferrer"`
and `referrerpolicy="no-referrer"`.

The page also ships a CSP that allows scripts only from its own origin, with no
`'unsafe-inline'` hole:

```html
<meta http-equiv="Content-Security-Policy"
      content="script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
```

That is a backstop, not the fix: it would stop an injected `<script>` even if a
future edit forgot a check. If you add your own inline script to `index.html`, CSP
will block it — load it as a file instead.

Proved by tests: `tests/unit.test.js` (“the guard” section), `tests/browser.test.js`
(“a link cannot turn the *open it on the host* button into script”, “a hostile file
name is shown as text, never as markup”, “the page never runs anything that is not
one of its own files”).

## The `To:` line of the composed email

`mailto:` URLs are built by concatenation, and a pasted address list containing
`?cc=victim@evil.com` or `#` would have extended the URL — adding recipients or
headers the sender never chose. Addresses are now validated individually
(`MD.email.safeAddress`); anything that is not an address is dropped and reported,
and `mailtoUrl` never interpolates raw text.

## Verification: what the fingerprints do and do not prove

* Each part carries a 16-hex-character **folded digest** (`SHA-256` of the
  `SHA-256`s of 16 MiB windows) of the bytes as stored on the host. With a password
  those bytes are ciphertext, so the check costs the host no information.
* `m.h` is either the same folded digest over the whole file, or — above
  `MD.app.FOLD_LIMIT` (8 GiB, because a second full read of a huge file is a rude
  wait) — the digest of the part digests (`hm: "parts"`). The latter still binds
  every part to the set the sender uploaded: swapping a part, dropping one, or
  reordering them changes it. What it cannot do is prove the parts themselves were
  the sender's plaintext.
* A link with **no** fingerprints is no longer reported as verified. `assemble()`
  returns `checkable: false` and the page says the bytes were not checked. Silence
  is not a pass.
* A truncated file is caught by `z` (declared size) versus what arrived.
* This verifies *transport*. It is not a signature: nobody but the sender's browser
  ever saw the file, and there is no key, so "the sender really sent this" is a
  claim about the email you received, not something the page can prove.

## What is deliberately *not* protected

* **The link is the capability.** Anyone who reads the email, the host's logs, a
  proxy, or a forwarded message can download the file. Short expiry and a password
  are the mitigations; both are optional and off by default because the common case
  is a folder of holiday videos.
* **The public hosts can read what you upload** (unless you set a password) and can
  serve you different bytes tomorrow — which is exactly what the per-part digest
  catches. Their rate limits and sudden policy changes are the real risk to the app
  working at all; see [PROVIDERS.md](PROVIDERS.md).
* **A bucket secret typed into this browser lives in `localStorage`.** It is not
  sent anywhere except as a SigV4 signature to your endpoint, but anyone with the
  machine profile can read it. Use a key scoped to the one bucket and prefix, and
  *Forget settings* on a shared machine.
* **No revocation, no receipts, no expiry you can enforce on someone else's host.**
  A static page cannot unsend anything.

## Memory, which is a security property here

The receive path never holds more than one 16 MiB window (or one encrypted record,
`32 MiB + 16`) at a time: parts are hashed, decrypted and written in that stream,
and the whole-file fingerprint is folded from the same windows. This was not a
performance nicety — the previous version concatenated each fetched part before
hashing it, so a 950 MiB part needed roughly twice that in RAM and a big download
would reliably kill the tab. `node tools/stress-5gb.mjs` runs 5 GiB through the
real page on a 2 GB machine and asserts the file arrives byte-identical; the
largest window it ever held was 16 MiB (`tests/integration.test.js` asserts that
directly too).

Where the browser offers no way to stream to disk — Safari, and Firefox until its
save-file picker ships — the whole file would have to be held in memory, and that
is not a thing a 5 GiB transfer survives. The page therefore refuses above a
stated ceiling (`MD.config.maxMemoryBlob`, or 30 % of `navigator.deviceMemory`
where the browser reports one) instead of trying and dying, and hands over the
host address so the file can still be had.

## The half-finished job, which is a record with capabilities in it

To continue an upload that died, the page keeps a small record in this browser's
`localStorage`: the part ids it had already stored, their sizes and digests, and
for an encrypted job the salt, the IV prefix and the password verifier. It is
deliberately the same kind of thing the link itself is — an id is what grants
access to an object — and it deliberately holds no password and no key, so a
continuation still needs the password typed again, and a *different* password is
refused rather than mixed into the file (the verifier is what catches that).

What follows from it: anyone with this browser can finish or reconstruct a job that
did not complete, exactly as they could with a link from the history list. The
record is cleared when the job finishes, when you press Cancel, when you choose
Start over, and by *Wipe* in Settings. `MD.config.rememberAttempts = false` keeps
the browser from writing it at all, at the cost of starting over each time.

## What an abandoned upload leaves behind

A send that fails at part 7 has put 6 parts on the host. No link points at them,
so nothing can be reassembled from them — but the bytes exist until the host's
clock deletes them, and a free host offers no way to hurry that along. The page
says how many are stranded and until when, rather than letting "Cancelled" imply
nothing happened, and it puts those parts to use: the next Start continues from
part 8 instead of uploading 7 parts again and leaving twice as much behind.

A bucket you hold credentials for is where the choice is real. A *failure* keeps
the parts, because continuing is the useful thing; *Cancel* and *Start over* delete
them, because those are decisions to abandon. That needs `DELETE` allowed in the
bucket's CORS settings; without it the page reports which objects survived and
gives the keys, which are the part ids in the failed link, so they can be removed
by hand.
