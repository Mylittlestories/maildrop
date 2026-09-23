# Reporting a vulnerability

MailDrop is a static page whose whole job is moving bytes and handing you a link,
so the interesting bugs are the ones where a link, a file name or a host response
makes somebody's browser do something it should not.

**Open an issue only if it is not exploitable.** For anything that is — a way to
run code from a crafted link, read a file you were not sent, or forge a
"fingerprint matched" verdict — please use
[private vulnerability reporting](https://github.com/Mylittlestories/maildrop/security/advisories/new)
so the fix can land before the detail is public.

What is worth reporting, and what is a property of the design rather than a bug, is
written out in [docs/SECURITY.md](docs/SECURITY.md): the manifest in a link is
attacker input and is treated that way, what the fingerprints do and do not prove,
why the link itself is the capability, and why "no server" means nobody can revoke a
link you have already sent.

## Supported versions

Any commit on `main`. This is a single-page app with a static host: there are no
release branches to backport to, and the fix is published by redeploying. There is
no telemetry, so there is no way to know who is running what — which is also why
there is no way for a maintainer to force an update.
