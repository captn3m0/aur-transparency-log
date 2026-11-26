# Usage: trusted timestamps for an AUR package

Walkthrough for `pelagos`: clone it from the AUR, list its commits, then ask the
log when each commit was first seen. Git commit dates are set by the pusher and
prove nothing; the log time comes from Sigstore's timestamp authority.

```sh
B=https://aur-tl.captnemo.in
```

## 1. Clone and list commits

```sh
git clone https://aur.archlinux.org/pelagos.git
cd pelagos
git log --format='%H %ad %s' --date=iso -n 4
```

```
b55946f1db48748208f34d830e1e184328bb40c7 2026-11-26 15:24:03 +0000 upgpkg: pelagos 0.65.116
1deee7df56fb470f565ff2969614e1a8773fae0e 2026-11-25 21:53:34 +0000 upgpkg: pelagos 0.65.115
8891a332d42615e235f14608be2c66bef8c79df9 2026-11-25 04:38:34 +0000 upgpkg: pelagos 0.65.114
9d7e57235d93b0cea55f6038791e23379b7e4ae7 2026-11-25 02:21:32 +0000 upgpkg: pelagos 0.65.113
```

The same history is browsable at
https://aur.archlinux.org/cgit/aur.git/log/?h=pelagos

## 2. Look up one commit

`GET /v1/pkg/<pkgbase>/commit/<sha>` is immutable once found.

```sh
for c in $(git log --format=%H -n 3); do
  curl -s $B/v1/pkg/pelagos/commit/$c
  echo
done
```

```json
{"pkgbase":"pelagos","commit":"b55946f1db48748208f34d830e1e184328bb40c7","status":"ok","time":1795706919,"bundle":"https://aur-tl.captnemo.in/b/1795706919-8673cc94.sigstore.json"}
{"pkgbase":"pelagos","commit":"1deee7df56fb470f565ff2969614e1a8773fae0e","status":"ok","time":1795651383,"bundle":"https://aur-tl.captnemo.in/b/1795651383-464d7011.sigstore.json"}
{"pkgbase":"pelagos","commit":"8891a332d42615e235f14608be2c66bef8c79df9","status":"not_observed"}
```

`time` is Unix seconds (1795706919 is 2026-11-26 15:28:39 UTC). The third commit
predates the log (see Limits in the README), so it is `not_observed`.

## 3. History of the package

```sh
curl -s $B/v1/pkg/pelagos/history | jq -c '.items[] | {commit: .commit[0:8], time}'
```

```
{"commit":"b55946f1","time":1795706919}
{"commit":"1deee7df","time":1795651383}
```

## 4. Newest commit at or before a cutoff

This is the call an AUR helper uses for a cooldown. `before` must be a multiple
of 3600.

```sh
curl -s "$B/v1/pkg/pelagos?before=1795708800"
curl -s "$B/v1/pkg/pelagos?before=1795654800"
curl -s "$B/v1/pkg/pelagos?before=1795651200"
```

```json
{"pkgbase":"pelagos","status":"ok","commit":"b55946f1db48748208f34d830e1e184328bb40c7","time":1795706919,"bundle":"https://aur-tl.captnemo.in/b/1795706919-8673cc94.sigstore.json"}
{"pkgbase":"pelagos","status":"ok","commit":"1deee7df56fb470f565ff2969614e1a8773fae0e","time":1795651383,"bundle":"https://aur-tl.captnemo.in/b/1795651383-464d7011.sigstore.json"}
{"pkgbase":"pelagos","status":"too_new","newest_time":1795706919}
```

A 7-day cooldown cutoff:

```sh
before=$(( $(date +%s) / 3600 * 3600 - 7*86400 ))
curl -s "$B/v1/pkg/pelagos?before=$before"
```

`too_new` means the newest commit is after the cutoff: fail the cooldown, or walk
back with `/history`. An unrounded value returns 400 with the rounded value in
`suggest`.

## 5. Many packages in one request

```sh
curl -s "$B/v1/batch?before=1795708800&pkg=pelagos&pkg=crush" | jq -c .
```

```json
{"before":1795708800,"results":[{"pkgbase":"crush","status":"ok","commit":"d57c6c3e...","time":1795708713,"bundle":"..."},{"pkgbase":"pelagos","status":"ok","commit":"b55946f1...","time":1795706919,"bundle":"..."}],"bundles":["https://aur-tl.captnemo.in/b/1795708713-1d4c655c.sigstore.json","https://aur-tl.captnemo.in/b/1795706919-8673cc94.sigstore.json"]}
```

## 6. Recently attested feed

```sh
curl -s $B/v1/recent | jq -c '.items[] | select(.pkgbase=="pelagos")'
```

Only the newest cycles appear here; use it to watch for fresh commits.

## 7. Verify without trusting the API

The API is a convenience. The bundle is what proves the time. Take the bundle URL
from any response above.

A bundle names its signing key by `publicKey.hint` (base64 SHA-256 of the key).
`/v1/keys` lists every key ever used with its `hint`; pick the one that matches:

```sh
curl -sO $B/b/1795706919-8673cc94.sigstore.json
hint=$(jq -r .verificationMaterial.publicKey.hint 1795706919-8673cc94.sigstore.json)
curl -s $B/v1/keys | jq -r --arg h "$hint" '.keys[] | select(.hint == $h) | .pem' > worker.pub
```

An empty `worker.pub` means the key is unknown: do not trust the bundle.

```sh
printf %s 'aur/pelagos' > subject
cosign verify-blob-attestation --key worker.pub \
  --bundle 1795706919-8673cc94.sigstore.json \
  --type https://captnemo.in/aur-transparency-log/aur-published-key/v1 subject
```

The key is also served as JWKS at `/jwks.json`. Then confirm the commit is in the signed predicate:

```sh
jq -r .dsseEnvelope.payload 1795706919-8673cc94.sigstore.json | base64 -d |
  jq -c '.predicate.entries[] | select(.pkgbase=="pelagos")'
```

```json
{"pkgbase":"pelagos","commit":"b55946f1db48748208f34d830e1e184328bb40c7","before":"1deee7df56fb470f565ff2969614e1a8773fae0e"}
```

Finally read the time from the RFC 3161 token, not from the API:

```sh
jq -r '.verificationMaterial.timestampVerificationData.rfc3161Timestamps[0].signedTimestamp' \
  1795706919-8673cc94.sigstore.json | base64 -d > token.tsr
openssl ts -reply -in token.tsr -text | grep -E 'Time stamp|TSA'
```

```
Time stamp: Nov 26 15:28:39 2026 GMT
TSA: DirName:/O=sigstore.dev/CN=sigstore-tsa
```

This matches `time` from the API (1795706919) and is later than the commit date
(15:24:03), as it must be. `openssl ts -verify` against the Sigstore TSA chain
checks the token signature, and the bundle's `tlogEntries` hold the Rekor v2
inclusion proof.

## 8. Monitor every entry made by our key

Rekor v2 has no search API, so "all proofs by this key" means scanning the log
for entries whose public key matches ours. [rekor-monitor](https://github.com/sigstore/rekor-monitor)
does this for v2 logs. The fingerprint it matches is the hex SHA-256 of the DER
public key, which is also the bundle's `publicKey.hint` (base64):

```sh
openssl pkey -pubin -in worker.pub -outform DER | sha256sum
# 6cb2c44d43a74be855556c903611bfbb54f2f92785997f85920ca61ccd9212fe
```

```sh
go install github.com/sigstore/rekor-monitor/cmd/rekor_monitor@latest
rekor_monitor --url https://log2025-1.rekor.sigstore.dev \
  --once=false --interval=10m --file ./rekor-checkpoint.log \
  --config 'startIndex: 217856000
monitoredValues:
  fingerprints:
    - 6cb2c44d43a74be855556c903611bfbb54f2f92785997f85920ca61ccd9212fe'
```

It verifies log consistency and reports each matching entry. Set `startIndex`
near the first entry you care about, since scanning the whole log is slow.
Any entry matching our fingerprint that is not in `/v1/recent` or a published
bundle means the key signed something this log did not publish.
