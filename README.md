# aur-transparency-log

Trusted publish timestamps for AUR commits, so AUR helpers can enforce
dependency cooldowns (among other things).

Live: https://captnemo.in/aur-transparency-log/ and https://aur-tl.captnemo.in/

This observer records when a commit was first seen on aur.archlinux.org and
signs it. The time comes from Sigstore's timestamp authority - you can trust
it without trusting this website.

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

## Verify

See [USAGE.md](USAGE.md), also at https://captnemo.in/aur-transparency-log/usage.html.

### Key `worker-1`:

https://aur-tl.captnemo.in/v1/keys.pem (PEM), https://aur-tl.captnemo.in/jwks.json (JWKS).

## Limits

- No HA guarantees.
- No entries before 2026-11-25.
- Trusted timestamps might be much beyond `LastModified` returned from the AUR, since I didn't want to do timestamping myself.