# aur-transparency-log

Trusted publish timestamps for AUR commits, so AUR helpers can enforce
dependency cooldowns. Live page: https://captnemo.in/aur-transparency-log/

Git commit dates are set by the pusher. This observer records when a head was
first seen on aur.archlinux.org and signs it; the time comes from Sigstore
(Rekor), not from this project.

## How it works

Every 5 minutes (GitHub cron, best effort) `.github/workflows/observe.yml`:

1. reads `/rss/modified` (ETag aware) for recently modified packages
2. maps names to pkgbases with the AUR RPC
3. confirms each head with `git ls-remote` on aur.archlinux.org (2 in flight)
4. writes one in-toto statement for the batch and signs it with `actions/attest`
   (keyless, GitHub OIDC, public Rekor, GitHub attestation store)

Subjects are `aur/<pkgbase>` with digest `sha256("aur/<pkgbase>")`, so all
attestations for a pkgbase can be looked up without knowing the commit. The
commits live in the predicate (`out/predicate.json`):

```json
{"observer": "...", "source": "https://aur.archlinux.org",
 "observed_at": "2026-11-25T17:33:42Z",
 "entries": [{"pkgbase": "yay", "commit": "<sha1>", "before": null, "modified_ts": 1795627745}]}
```

No state lives in this repo. A tiny cursor (`state.json`) is kept in the
Actions cache. If it is lost the next run re-attests the last 30 minutes;
duplicates are harmless because clients use the earliest entry.

## Cloudflare Worker (aur-tl.captnemo.in)

`worker/` is the main observer. A cron trigger runs every minute: it reads the
feed, confirms heads over git smart-HTTP (`info/refs`), signs one DSSE
statement per batch with an ECDSA P-256 key (WebCrypto), gets an RFC 3161
token from timestamp.sigstore.dev, and writes to R2. No k8s, no repo state.

R2 layout: `b/<cycle>.sigstore.json` (bundles), `c/<pkgbase>/<inverted-ts>-<commit>`
(newest first), `k/<pkgbase>/<commit>`, `s/state.json` (cursor).

API (all GET, CORS open):

- `/v1/pkg/<pkgbase>?before=<unix>` newest commit with timestamp at or before the
  cutoff. `before` must be a multiple of 3600 so responses cache. Status is
  `ok`, `too_new` (nothing old enough), or `not_observed`.
- `/v1/pkg/<pkgbase>/commit/<sha>`, `/v1/pkg/<pkgbase>/history`
- `/v1/batch?before=<unix>&pkg=a&pkg=b` plus the distinct `bundles` to fetch
- `/b/<cycle>.sigstore.json`, `/v1/keys`, `/jwks.json`, `/healthz`

Deploy: `worker/deploy.sh` (needs `wrangler login`).

## Verify

Fetch the bundle for a commit, then:

```sh
printf %s 'aur/yay' > subject
cosign verify-blob-attestation --key keys/worker-1.pub --bundle bundle.json \
  --type https://captnemo.in/aur-transparency-log/aur-published-key/v1 \
  --insecure-ignore-tlog --use-signed-timestamps subject
```

Then check that `predicate.entries` contains the commit, and take the time from
the RFC 3161 token (not from the API). Key `worker-1`, sha256 of DER
`6cb2c44d...12fe`, kid `Wjjw_PCbkNMkB04PWsPTQ5CP-yk7o8t74igNrB4si_4`. The JWKS
is at https://aur-tl.captnemo.in/jwks.json. `keys.json` lists keys with
validity windows.

Rekor is not used: v2 has no search or timestamps, so the TSA token is the
time source.

## Page

The page lists the 10 newest AUR updates via rss2json (the AUR feed has no
CORS headers), then asks GitHub's attestation API for each package. It assumes
pkgname equals pkgbase and does not verify signatures.

## Limits

- Cron can be delayed or dropped; the RSS feed holds about 90 minutes.
- Deletions and mirror reconciliation are not implemented yet.
- Scheduled workflows are disabled after 60 days without repo activity.
- Only observed heads are attested; the browser page does not verify signatures.

## Development

```sh
PYTHONPATH=src uv run --no-project python -m unittest discover -s tests -t .
```
