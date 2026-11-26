# aur-transparency-log

Trusted publish timestamps for AUR commits, so AUR helpers can enforce
dependency cooldowns (among other things).

Live: https://captnemo.in/aur-transparency-log/ and https://aur-tl.captnemo.in/

This observer records when a head was first seen on aur.archlinux.org and
signs it; the time comes from Sigstore's timestamp authority, not from this
project.

## API

Base URL `https://aur-tl.captnemo.in`.  All endpoints are GET with open CORS.

| Endpoint | Example |
| --- | --- |
| Newest commit at or before a cutoff | https://aur-tl.captnemo.in/v1/pkg/python-transformers?before=4102444800 |
| One commit | https://aur-tl.captnemo.in/v1/pkg/python-transformers/commit/6b25f276555d6503c814531c993a2c9fcf965055 |
| History, newest first | https://aur-tl.captnemo.in/v1/pkg/python-transformers/history |
| Many packages, one request | https://aur-tl.captnemo.in/v1/batch?before=4102444800&pkg=python-transformers&pkg=agent-of-empires-bin |
| Recently attested | https://aur-tl.captnemo.in/v1/recent |
| Signed bundle | https://aur-tl.captnemo.in/b/1795649492-6b25f276.sigstore.json |
| Signing key (JWK) | https://aur-tl.captnemo.in/v1/keys |
| Signing key (PEM) | https://aur-tl.captnemo.in/v1/keys.pem |
| JWKS | https://aur-tl.captnemo.in/jwks.json |
| OIDC discovery | https://aur-tl.captnemo.in/.well-known/openid-configuration |
| Health (cron age and last error) | https://aur-tl.captnemo.in/healthz |
| Index | https://aur-tl.captnemo.in/ |

`/v1/pkg` returns a `status`:

- `ok`
- `too_new` (the newest commit is newer than the
cutoff; fail the cooldown or roll back via `/history`)
- `not_observed`. A bad `before` returns 400 with the rounded value in `suggest`.

### Caching

bundles and commit lookups are immutable (one year); a cutoff more than
two hours old is immutable once it returns `ok`; `/history` and `/v1/pkg` for the
current hour cache for 5 minutes, `/v1/recent` for 1 minute, keys for a day.

Responses are also stored in the edge cache under a canonical key, so repeat
requests never reach R2.

### Timestamps

`before` is a Unix time that must be a multiple of 3600. 

You can compute a 7-day cooldown cutoff with something like:

`before=$(( $(date +%s) / 3600 * 3600 - 7*86400 ))` 

## Verify

Worked example for a real package (`pelagos`): clone it from the AUR, list its
commits, then fetch trusted timestamps through the commit, history, cutoff,
batch and recent endpoints, and verify the signed bundle and RFC 3161 token.
See [USAGE.md](USAGE.md).

Quick check of a bundle (take the time from the RFC 3161 token, not the API):

```sh
curl -s https://aur-tl.captnemo.in/v1/keys.pem -o worker.pub
curl -sO https://aur-tl.captnemo.in/b/1795649492-6b25f276.sigstore.json
printf %s 'aur/python-transformers' > subject
cosign verify-blob-attestation --key worker.pub \
  --bundle 1795649492-6b25f276.sigstore.json \
  --type https://captnemo.in/aur-transparency-log/aur-published-key/v1 subject
```

### Key `worker-1`:

https://aur-tl.captnemo.in/v1/keys.pem (PEM), https://aur-tl.captnemo.in/jwks.json (JWKS).

## Limits

- No HA guarantees.
- No entries before 2026-11-25.
- Trusted timestamps might be much beyond `LastModified` returned from the AUR, since I didn't want to do timestamping myself.