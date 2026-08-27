### How authentication works

- The web UI authenticates via an **httpOnly session cookie** (`om_session`,
  `SameSite=Strict`), so the token is never readable from JavaScript. The
  `Secure` flag is added automatically when the request arrives over HTTPS
  (directly, or via a reverse proxy with `TRUST_PROXY=1` set).
- Programmatic API clients can instead send the token returned by
  `POST /api/auth` in the `x-session-token` header.
- Session tokens are **HMAC-signed and stateless** (derived from
  `MASTER_KEY`), so logins survive container restarts. Rotating `MASTER_KEY`
  invalidates all sessions at once; logout revokes the individual token.
