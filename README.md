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
5. get RFC 3161 tokens over the signature (`TSA_URLS`: the first is required,
   any others are best-effort extras; `TSA_MIN` sets how many must succeed)
6. log a `hashedrekord` entry in Rekor v2 (`REKOR_URL`, Rekor v2 has no DSSE type)
7. write the Sigstore bundle and pointers to R2

Subjects are `aur/<pkgbase>` with digest `sha256("aur/<pkgbase>")`; commits
live in the predicate. Failures are recorded in `s/state.json` and surfaced at
`/healthz`; packages that fail a head check are retried up to 6 times.

R2 layout: `b/<cycle>.sigstore.json`, `c/<pkgbase>/<inverted-ts>-<commit>`
(newest first), `k/<pkgbase>/<commit>`, `s/state.json`.

Infrastructure (R2 bucket, Worker shell, domain, deploy token and the
`SIGNING_KEY` secret) is managed in nebula (`cloudflare/aur-tl.tf`); the secret
lives in pass at `Nebula/aur-tl/SIGNING_KEY`. `worker/deploy.sh` ships the code.

## API

Base URL `https://aur-tl.captnemo.in`. All endpoints are GET with open CORS.
`before` is a Unix time that must be a multiple of 3600, so a whole hour of
clients shares one cacheable URL. Compute a 7-day cooldown cutoff with
`before=$(( $(date +%s) / 3600 * 3600 - 7*86400 ))`; rounding down is stricter.

| Endpoint | Example |
| --- | --- |
| Newest commit at or before a cutoff | https://aur-tl.captnemo.in/v1/pkg/python-transformers?before=4102444800 |
| One commit | https://aur-tl.captnemo.in/v1/pkg/python-transformers/commit/6b25f276555d6503c814531c993a2c9fcf965055 |
| History, newest first | https://aur-tl.captnemo.in/v1/pkg/python-transformers/history |
| Many packages, one request | https://aur-tl.captnemo.in/v1/batch?before=4102444800&pkg=python-transformers&pkg=agent-of-empires-bin |
| Recently attested | https://aur-tl.captnemo.in/v1/recent |
| Signed bundle | https://aur-tl.captnemo.in/b/1795649492-6b25f276.sigstore.json |
| Signing key (JWK) | https://aur-tl.captnemo.in/v1/keys |
| JWKS | https://aur-tl.captnemo.in/jwks.json |
| OIDC discovery | https://aur-tl.captnemo.in/.well-known/openid-configuration |
| Health (cron age and last error) | https://aur-tl.captnemo.in/healthz |
| Index | https://aur-tl.captnemo.in/ |

`/v1/pkg` returns `status`: `ok`, `too_new` (the newest commit is newer than the
cutoff; fail the cooldown or roll back via `/history`) or `not_observed`. A bad
`before` returns 400 with the rounded value in `suggest`.

Caching: bundles and commit lookups are immutable (one year); a cutoff more than
two hours old is immutable once it returns `ok`; `/history` and `/v1/pkg` for the
current hour cache for 5 minutes, `/v1/recent` for 1 minute, keys for a day.
Responses are also stored in the edge cache under a canonical key, so repeat
requests never reach R2.

## Verify

```sh
curl -sO https://aur-tl.captnemo.in/b/1795649492-6b25f276.sigstore.json
printf %s 'aur/python-transformers' > subject
cosign verify-blob-attestation --key keys/worker-1.pub \
  --bundle 1795649492-6b25f276.sigstore.json \
  --type https://captnemo.in/aur-transparency-log/aur-published-key/v1 subject
```

The bundle also carries a Rekor v2 entry, so the command needs neither
`--insecure-ignore-tlog` nor `--use-signed-timestamps`. Check that
`predicate.entries` contains the commit, and take the time from the RFC 3161
token, not from the API. Key `worker-1`: sha256 of DER
`6cb2c44d...12fe`, kid `Wjjw_PCbkNMkB04PWsPTQ5CP-yk7o8t74igNrB4si_4`, JWKS at
https://aur-tl.captnemo.in/jwks.json. `keys.json` lists keys with validity
windows.

Rekor v2 has no search or timestamps: find an entry by the log index in the
bundle, and the TSA token is the time source. `REKOR_URL` points at one log
shard (`log2025-1`); update it when Sigstore's signing config rolls to a new one.

## Bootstrap

The current state of every package was entered as ordinary entries, so
`/v1/pkg`, `/history` and `/commit` behave the same for all of them.
`worker/scripts/bootstrap.mjs` takes the pkgbase list from the AUR metadata
dump (`packages-meta-ext-v1.json.gz`) and heads from the GitHub mirror (150 random
heads plus any missing are re-checked on the AUR), then signs 250 entries per
batch with a TSA token and a Rekor v2 entry, and writes the usual pointers to R2
through its S3 API. It skips entries already in R2, so it can be re-run. These
entries are stamped when they were first seen by this service (around launch); history
before that is not recoverable.

## Limits

- The feed keeps about 90 minutes; a long outage can miss packages.
- Deletions and mirror reconciliation are not implemented. History starts at launch; bootstrapped entries carry the launch time.
- The key is a Worker secret (kept in pass), not an HSM.
- The page does not verify signatures.

## Development

```sh
node worker/test/integration.mjs   # live cycle against a mock bucket
./worker/deploy.sh                 # ships the code (infra is in nebula)
```
