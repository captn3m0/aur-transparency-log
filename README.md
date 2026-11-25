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

## Verify

GitHub Actions identity (needs `gh`; the file is the subject name):

```sh
printf %s 'aur/yay' > subject
gh attestation verify subject -R captn3m0/aur-transparency-log \
  --predicate-type https://captnemo.in/aur-transparency-log/aur-published/v1 \
  --format json --jq '.[].verificationResult.statement.predicate'
```

Equivalent with cosign, pinning the workflow identity:

```sh
cosign verify-blob-attestation --bundle bundle.json \
  --certificate-identity https://github.com/captn3m0/aur-transparency-log/.github/workflows/observe.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --type https://captnemo.in/aur-transparency-log/aur-published/v1 subject
```

The signing key (`cosign.pub`, sha256 of DER `1ef7424d...e0199`) is used by a
separate deployment of this code, less often than the Actions identity. It has its own predicate type
`.../aur-published-key/v1` and issuer `https://captnemo.in/aur-transparency-log`; the predicate carries
`signer: {issuer, kid}`. The issuer publishes `/jwks.json` and
`/.well-known/openid-configuration` (discovery only, not a login provider).

```sh
cosign verify-blob-attestation --key cosign.pub --bundle bundle.json \
  --type https://captnemo.in/aur-transparency-log/aur-published-key/v1 subject
```

Match the `kid` in the predicate against
https://captnemo.in/aur-transparency-log/jwks.json. Regenerate the JWKS
with `python -m aurlog jwks --pub cosign.pub --out <dir>`.

A client passes a cooldown when the Rekor time of the earliest entry for the
commit is older than the cooldown. `keys.json` lists identities and keys with
validity windows.

## Run the key-signing observer (k8s)

```sh
export COSIGN_PASSWORD=...        # from a secret
python -m aurlog run --key /secrets/cosign.key --pub /secrets/cosign.pub \
  --state /data --out /tmp/out
```

`run` loops every 300s, signs with `cosign attest-blob` (Rekor and TSA via the
TUF signing config) and keeps bundles in `/data/bundles`. Needs `cosign` and
`git` in the image. Keep `/data` on a volume so the cursor survives restarts.

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
