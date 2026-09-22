# The 5 GB test, and the email that goes with it

Run on 2026-09-22 in the development sandbox, with `npm run stress -- --gb 5 --part 96 --keep`.
The dummy file was 5 GiB of `/dev/urandom` (`field-recording.mkv`), and the transfer was
carried out by the real page — `index.html` with its ten scripts booted in jsdom, the real
`XMLHttpRequest` code path, real HTTP against `tools/mock-host.mjs`.

## What happened

```
  10.5s  start pressed; part size 96 MB, plaintext
  101.6s  SENT. 28 parts, link 3543 chars, token 3519 chars, 817 MB rss → 0.05 GiB/s
  101.7s  the recipient opens the link (3543 chars)
  102.0s  the recipient chose: field-recording.mkv → received-5gb.bin
  168.0s  closed the file at 5120.0 MB
  169.0s  RECEIVED in 66.9 s · 0.07 GiB/s · peak rss 1044 MB
  the page says: saved — 5 GiB reassembled · fingerprint c9870e639cef matched

  source  sha256 d69ba227c636991d296b2275b49b35c71b5c97618513a5496b3eedb0abce4b7b
  saved   sha256 d69ba227c636991d296b2275b49b35c71b5c97618513a5496b3eedb0abce4b7b
  ✓ byte-for-byte identical over 5120 MiB through the real page
```

5 368 709 120 bytes out, the same 5 368 709 120 bytes back, hash equal at the end and
fingerprint equal at the receive step (the page checks each part's 16-hex prefix too).
The tool exits non-zero if any of that fails, so this is a gate, not a log line.

Two things this run changed in the code, because they were found by it and not by reading:

1. **The link budget was checked after the upload.** At 64 MiB parts the plan wanted 84
   parts and the token came to 9 746 characters — twice the 6 200 budget. The page
   uploaded for two minutes and *then* refused to build the link. `MD.app.plan` now
   encodes a trial manifest and grows the part size until the link fits (128 MiB →
   40 parts → 4 920 characters), and refuses a file that cannot fit at all before
   sending a byte. See the plan box: *"Per-part size was raised to 183 MiB so the link
   still fits in an email."*
2. **An abort listener was added per part and never removed** — 84 parts on one
   `AbortSignal` produced Node's `MaxListenersExceededWarning`, and Cancel could hang,
   because `XMLHttpRequest.onabort` was never wired. One listener per request, removed
   as soon as it settles, and Cancel now reports "cancelled" instead of nothing.

The peak of 1 044 MB is the *harness*, not the page: `tests/xhr-shim.js` materialises each
part with `arrayBuffer()` because jsdom's XHR cannot stream a Blob body. The browser hands
the Blob to `xhr.send()` and reads the download in 16 MiB windows.

## Why nothing arrived in georgederve@gmail.com

This sandbox has no mail transport — `command -v sendmail mail msmtp ssmtp mutt` returns
nothing, there are no credentials, and the app is designed not to have any: it composes the
message and hands it to *your* mail client (`mailto:`), which is the whole reason it can run
on a static page. The public hosts that could have carried the 5 GiB object also refused this
IP during the session (`litterbox.catbox.moe` answered 403 to its preflight and 500 to an
upload; `tmpfiles.org` hands back an HTML landing page instead of bytes).

So the transfer is proven here, and below is the message to send from your machine, where the
link will be real.

## Sending it for real (two commands)

```bash
cd maildrop && npm run serve      # http://localhost:8080  (or use your GitHub Pages URL)
```

Open the page → **1** choose the file → **2** pick *Litterbox (72 h)* and leave the part size
on auto → **3** Start transfer → the link card has a **Copy message** button. Paste it to
`georgederve@gmail.com`. The file itself never touches your mail; the message is about
1 100 characters.

To repeat this exact test on your own machine, where both ends are fast and nothing is
simulated:

```bash
npm run stress -- --gb 5 --part 96 --keep
```

## The message

> **To:** georgederve@gmail.com
> **Subject:** field-recording.mkv — 5 GB, link good for 3 days
>
> Download: https://litter.catbox.moe/«your-id»
>
> If your browser refuses that link, open this page instead and it will fetch the file
> for you, verify it and save it: https://«your-github-pages-url»/index.html#«token»
>
> Held by: litter.catbox.moe — deleted automatically after 72 hours.
> Size: 5 GiB (5 368 709 120 bytes). SHA-256 d69ba227c636991d296b2275b49b35c71b5c97618513a5496b3eedb0abce4b7b
>
> The second line is the one worth keeping: the whole transfer lives in that link, so the
> page can rebuild a file the host will no longer give a browser direct access to.
> Nothing is uploaded to that page — it only ever talks to the host above.
>
> — sent with MailDrop

Keep the two links on separate lines and unbroken: mail clients wrap long lines and a
token split across one is the only way this link can be lost.
