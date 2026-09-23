# Security policy

MailDrop is a static page with no backend, so "security" here means two things:
what a malicious *link* can do to the page that opens it, and what the page can
make your browser do to a file host. Both are analysed in
[`docs/SECURITY.md`](docs/SECURITY.md), which is written as a threat model with
the specific guard in the code next to each item — read that first, and read
[`docs/PRIVACY.md`](docs/PRIVACY.md) for what the page cannot promise.

## Reporting a vulnerability

Open a [draft security advisory](https://github.com/Mylittlestories/maildrop/security/advisories/new)
rather than a public issue. You get a private thread with the maintainers, and the
details stay private until a fix exists.

There is no bug bounty, and this project has no funding, so the honest promise is:

* a reply within a week, and an acknowledgment either way;
* a fix or a documented, explained refusal before the advisory is disclosed;
* credit in the release notes if you want it.

## What is out of scope

Things that are properties of the design, and are documented rather than fixed:

* **A link is the capability.** Anyone holding it can download the file. There is
  no per-recipient access control, and no way to revoke after sending — the bytes
  are on a third-party host and the link is in an inbox.
* **Free hosts can be unavailable, rate-limiting, or hostile to datacenter IPs.**
  The page reports what failed; it cannot make a host cooperate.
* **No virus scanning.** A file that arrives is checked against the sender's own
  fingerprint and nothing else. Any anti-malware duty belongs to the mail provider
  or the recipient's machine.
* **`no-referrer` and a hash fragment are what keep the link out of server logs** —
  but the file host still sees the object being fetched, and its access log holds
  the id for as long as it keeps the file.

## If you are auditing before trusting it

The whole client is ten small files in `lib/`, and `tests/page.test.js` asserts the
shipped page loads nothing that is not one of them, with a Content-Security-Policy
that forbids inline and third-party script. `npm test` runs four suites against the
real page over real HTTP; `npm run stress` pushes 5 GiB through it and compares
hashes. There is no build step, so what you read is what runs.
