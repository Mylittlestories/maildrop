# Privacy, honestly

MailDrop is a page, not a service. There is no MailDrop company, no analytics, no
account, no log file with your name in it. So the interesting questions are about
the *other* two parties: the file host and your mail provider.

## What the page itself does

| Data | Where it goes |
|---|---|
| Your file's bytes | from your browser straight to the host you picked in the dropdown. Never through the page's own origin — a static page has no "own origin" that could hold them. |
| The manifest (name, size, type, part ids, fingerprints) | into the URL hash of the link you compose. It is in the email you send. |
| Settings, including a bucket secret key | `localStorage` of the browser you typed them into. `Settings → Forget settings, history and test-mode data` deletes it. |
| The transfer history (link + name + size + time) | `localStorage`, same place, same button. |
| Anything at all to us | nothing. There is no request in the code that could make that table longer. |

The page loads no font, no script, no stylesheet, no image from anywhere but its
own folder — `tests/page.test.js` asserts that, because it is the kind of thing
that quietly regresses when someone adds "just one" CDN link.

## The hash is not encrypted, and the host sees the URL

Two facts worth being precise about:

* The manifest travels in the **hash**, so it is not sent to the web server that
  serves the page and does not appear in its access log. But the *link* itself is
  inside your email, and anyone who can read that mail can read the manifest and
  fetch the parts. The link is the capability; possession of it is the authorisation.
* A public host (Litterbox) necessarily stores your bytes in the clear unless you
  tick the password box. Its operators can read what you uploaded, in the same way
  the staff of a copy shop can read what you printed. It is *temporary* storage
  with a deletion deadline, not *private* storage.

So:

* **Ordinary, unremarkable files you are happy to hand to a stranger with the
  link** → Litterbox, no password, nothing to think about.
* **Anything you would not post on a noticeboard** → tick *Add a password* (then
  the host stores only ciphertext and the per-part fingerprints are taken over the
  ciphertext too), or use your own bucket.
* **Contracts, passports, payroll, source code, client work** → your own bucket
  with a scoped key, and a password anyway. Short expiry. Do not rely on a link
  being hard to guess.

## What the recipient's browser does

When they open your link, their browser sends a `GET` for each part to the *host*,
not to the page: the host learns their IP, the time, and which part ids were
fetched. If you do not want that, host the parts somewhere you control. The page
itself is fetched from wherever you published it, which is the only thing your
Pages host can see, and a `#hash` never reaches a server log.

## If you self-host the page

Nothing changes: still no server code, still no database. Your static host sees a
`GET /index.html` and a handful of `GET /lib/*.js`. Your bucket, if you use one,
sees the part traffic between your sender's/recipient's browsers and *them* — with
presigned URLs, so no key is involved on their side at all.

## Two things people ask about

**"Does the file name leak?"** Yes — it is in the manifest, in the email, and (for
most hosts) in the object URL. If `Q3-layoffs-final.xlsx` is itself sensitive, name
the file something dull before you start, or tick the password box: with a password
the *name* is still in the link (so it can be shown before asking for the
password), but the bytes are unreadable without it. If you want the name hidden
too, zip it and name the zip `transfer.zip`.

**"Can I make a link that cannot be forwarded?"** Not with a static page — that
requires a server that authenticates the recipient, which is exactly what this
project refuses to be. What you can do: short expiry (1 h on Litterbox), a password
sent through a different channel, and a bucket key you can revoke in ten seconds.
A link plus a one-time password plus a 1-hour clock is the honest version of the
same idea.

## Deletion, in practice

Litterbox deletes on its own clock: 1 h / 12 h / 24 h / 72 h, and the expiry you
picked is what the page tells the recipient. Your own bucket: use the lifecycle
rule you configured, or delete the prefix. The in-page test backend keeps parts
only in that tab's memory — closing it is the delete.

Nothing in this project offers "shred" or "revoke a sent link", and no tool can,
once the bytes are on a host and the link in an inbox. That is a property of email,
not of this page.

A send you abandon halfway is a smaller version of the same problem, and it is the
one place the page can act: 6 of 28 parts on the host have no link pointing at
them, but they are still bytes on somebody's disk. On a free host there is no
delete API, so the page tells you how many parts are stranded and until when,
rather than letting "Cancelled" imply that nothing was stored. On your own bucket
it holds the credentials, so it uses them: parts already uploaded are deleted the
moment the job dies or you press Cancel, and the report says how many were
removed. That needs `DELETE` in the bucket's CORS settings — see SETUP-BUCKET.md.
