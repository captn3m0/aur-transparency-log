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

## Development

```sh
node worker/test/integration.mjs   # live cycle against a mock bucket
./worker/deploy.sh                 # ships the code (infra is in nebula)
```

## Key rotation (plan)

Not implemented yet: the Worker loads exactly one key from `SIGNING_KEY`, and
`/v1/keys`, `/v1/keys.pem` and `/jwks.json` serve only that key.

Constraints:

- Bundles carry only a key hint (base64 SHA-256 of the SPKI), not the key, so
  verifiers need every key ever used. Old keys must stay published forever.
- Bundles and R2 pointers are immutable and never re-signed.
- A bundle's time comes from the RFC 3161 token, so a signature stays
  provable after its key is retired. After a compromise, only bundles whose
  token predates the compromise can be trusted.
- Observer gaps are not recoverable: nothing is attested while no key signs.

Plan:

1. Generate `worker-2` (ECDSA P-256) and commit `keys/worker-2.pub`. Keep
   `worker-1.pub`.
2. Add a `RETIRED_KEYS` var (public PEMs, no secrets). `loadKey` stays for the
   active key; the retired ones are parsed to JWK, SPKI and hint only.
3. Serve every key: `/v1/keys` and `/jwks.json` list active first, then retired,
   each with `kid`, `hint`, `pem` and a `status`. `/v1/keys.pem` concatenates the PEMs.
4. Verifiers pick the key whose hint matches the bundle's `publicKey.hint`
   (USAGE.md already does, via `/v1/keys`).
5. Overlap: publish the new public key and deploy step 3 at least a week before
   switching, so cached clients and monitors learn it first.
6. Switch: update `SIGNING_KEY` in nebula and pass (`Nebula/aur-tl/SIGNING_KEY`),
   apply, then `worker/deploy.sh`. Confirm with `/healthz` and that the next
   bundle's hint equals the new key's hash.
7. Add the new fingerprint to rekor-monitor config; keep the old one to see any
   late use of it.
8. Move the old key to `RETIRED_KEYS`. Destroy its private half.

Compromise: do the switch immediately, record the earliest suspect time in
README, and treat bundles whose TSA time is later than it as untrusted.

Cadence: yearly, or on any suspected exposure.
