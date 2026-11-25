# aur-transparency-log

Trusted publish timestamps for AUR commits, so AUR helpers can enforce
dependency cooldowns. Live: https://captnemo.in/aur-transparency-log/ and
https://aur-tl.captnemo.in/

Git commit dates are set by the pusher. This observer records when a head was
first seen on aur.archlinux.org and signs it; the time comes from Sigstore's
timestamp authority, not from this project.

## How it works

`worker/` is a Cloudflare Worker with a cron trigger every minute:

1. read `/rss/modified` (ETag aware) for recently modified packages
2. map names to pkgbases with the AUR RPC
3. confirm each head over git smart-HTTP (`info/refs`), 2 in flight
4. sign one in-toto statement per batch (ECDSA P-256, WebCrypto, DSSE)
5. get an RFC 3161 token from timestamp.sigstore.dev over the signature
6. write the Sigstore bundle and pointers to R2

Subjects are `aur/<pkgbase>` with digest `sha256("aur/<pkgbase>")`; commits
live in the predicate. Failures are recorded in `s/state.json` and surfaced at
`/healthz`; packages that fail a head check are retried up to 6 times.

R2 layout: `b/<cycle>.sigstore.json`, `c/<pkgbase>/<inverted-ts>-<commit>`
(newest first), `k/<pkgbase>/<commit>`, `s/state.json`.

Infrastructure (R2 bucket, Worker shell, domain, deploy token) is managed in
nebula (`cloudflare/aur-tl.tf`); `worker/deploy.sh` ships the code.

## API

All GET, CORS open:

- `/v1/pkg/<pkgbase>?before=<unix>`: newest commit with a timestamp at or before
  the cutoff. `before` must be a multiple of 3600 so responses cache. Status is
  `ok`, `too_new` (nothing old enough yet) or `not_observed`.
- `/v1/pkg/<pkgbase>/commit/<sha>`, `/v1/pkg/<pkgbase>/history`
- `/v1/batch?before=<unix>&pkg=a&pkg=b` plus the distinct `bundles` to fetch
- `/v1/recent`, `/b/<cycle>.sigstore.json`, `/v1/keys`, `/jwks.json`, `/healthz`

## Verify

```sh
printf %s 'aur/yay' > subject
cosign verify-blob-attestation --key keys/worker-1.pub --bundle bundle.json \
  --type https://captnemo.in/aur-transparency-log/aur-published-key/v1 \
  --insecure-ignore-tlog --use-signed-timestamps subject
```

Then check that `predicate.entries` contains the commit, and take the time from
the RFC 3161 token, not from the API. Key `worker-1`: sha256 of DER
`6cb2c44d...12fe`, kid `Wjjw_PCbkNMkB04PWsPTQ5CP-yk7o8t74igNrB4si_4`, JWKS at
https://aur-tl.captnemo.in/jwks.json. `keys.json` lists keys with validity
windows.

Rekor is not used: v2 has no search or timestamps, so the TSA token is the
time source.

## Limits

- The feed keeps about 90 minutes; a long outage can miss packages.
- Deletions, bootstrap of pre-launch heads and mirror reconciliation are not
  implemented. History starts at launch.
- The key is a Worker secret, not an HSM.
- The page does not verify signatures.

## Development

```sh
node worker/test/integration.mjs        # live cycle against a mock bucket
PYTHONPATH=src uv run --no-project python -m unittest discover -s tests -t .
```

`src/aurlog` is the earlier Python observer (cosign based); it is kept as a
local reference and is not deployed.
