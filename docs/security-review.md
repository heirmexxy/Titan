# Titan security review (November 2026)

This is an internal review of the Titan code before the first bank pilot. It is not a substitute for an outside penetration test, which should happen before Titan holds data for more than a handful of sites.

## Fixed in this review

| # | Finding | Risk | Fix |
|---|---|---|---|
| 1 | The client IP was taken from the first `X-Forwarded-For` entry, which any client can set. | Login, sign-up and reset rate limits could be bypassed by sending a fake header on each try. | Forwarded headers are trusted only from the proxy (this machine or the Docker bridge), using the last entry, which is the address the proxy saw. |
| 2 | The EMQX hook endpoints (`/internal/emqx/*`) were reachable through the public web proxy, protected only by the shared secret. | If the secret leaked, anyone could approve device logins or inject messages. | They now answer only direct calls from the same machine. A proxied request is refused even with the right secret. |
| 3 | The static-file check would have allowed a sibling folder whose name starts with the web folder's name (`/web-…`). A malformed URL caused a server error. | Possible file disclosure if such a folder ever existed; noisy errors. | The path must be inside the web folder exactly; bad encodings return 404. |
| 4 | No browser security headers. | Clickjacking of the admin, MIME sniffing, and no defence-in-depth against injected scripts. | Every response sends `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security` and `Permissions-Policy`. HTML pages add a `Content-Security-Policy` (own origin only, Google Fonts, Paystack checkout as the only outside form target, no framing) and `X-Frame-Options: DENY`. API responses are `Cache-Control: no-store`. |
| 5 | The public PAYG pay page had no rate limit. | Guessing short payment codes to learn customers' first names and credit dates. | 30 page views and 10 payment attempts per minute per address. |
| 6 | Webhook subscriptions returned the signing secret only inside `webhook`; reading events had no `device` field. | StorageX could not subscribe to live updates, and its duplicate check could drop readings from different devices with the same sequence number. | `id` and `secret` are also returned at the top level; reading events include `device`. |

## Checked and in order

- **Passwords:** scrypt with a per-user salt; at least 10 characters for new accounts; reset links are single-use, last 2 hours, are stored only as hashes, and end all other sessions.
- **Sessions:** random 256-bit tokens stored as SHA-256 hashes; cookies are `HttpOnly`, `SameSite=Lax` and `Secure` in production; every state-changing request also needs a custom header (`X-Titan-Admin`, `X-Titan-Console`, `X-Titan-Verify`), which other sites cannot send.
- **API keys and device tokens:** stored only as SHA-256 hashes; per-key scopes; 600 requests a minute per key.
- **Device data integrity:** every reading is Ed25519-signed by the device; replayed sequence numbers are ignored; firmware updates are signed and checked on the device before installing.
- **SQL:** every value is passed as a parameter. The few places that build SQL text use fixed values only (time-bucket sizes, table names from a fixed list).
- **Cross-site scripting:** every page escapes data before inserting it; server-rendered pages (pay page, reports) escape all values; CSV exports neutralise spreadsheet formulas.
- **Access between organisations:** every console and API query is filtered by the caller's organisation; data shared with other organisations goes only through explicit grants, limited by site, metric and dates.
- **Payments:** Paystack webhooks are checked with HMAC-SHA512 in constant time; each payment is confirmed again with Paystack before it is credited; PAYG payments are recorded once per reference.
- **Secrets on the server:** `.env`, the database password and the firmware signing key are readable only by their owners (mode 600); none are in the repository.

## Still to do

1. **Outside penetration test** before scaling past the pilot.
2. **Two-factor sign-in for Kitovu admins.** Admin accounts can see every organisation.
3. **Encrypted off-site backups.** The off-server copy goes to Kitovu's other server over SSH. Before backups go to any third-party storage (Google Drive), encrypt them.
4. **Dependency watch.** Titan has very few dependencies (`pg`, `marked` for docs). Run `npm audit` monthly.
5. **Data protection:** register Kitovu with the NDPC, and publish the privacy notice (see `docs/data-protection.md`).
