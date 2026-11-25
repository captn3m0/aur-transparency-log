import { b64, b64u, concat, ecdsaRawToDer, enc, fromB64, fromB64u, fromHex, hex } from "./der.js";
import { timestamp } from "./tsa.js";

const SPKI_PREFIX = fromHex("3059301306072a8648ce3d020106082a8648ce3d030107034200");
export const PAYLOAD_TYPE = "application/vnd.in-toto+json";
export const PREDICATE_TYPE = "https://captnemo.in/aur-transparency-log/aur-published-key/v1";

export async function loadKey(pem) {
  const der = fromB64(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const canon = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const kid = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(canon))));
  const spki = concat(SPKI_PREFIX, Uint8Array.of(4), fromB64u(jwk.x), fromB64u(jwk.y));
  const hint = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", spki)));
  const pub = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid, use: "sig", alg: "ES256" };
  return { key, jwk: pub, kid, spki, hint };
}

export async function sha256hex(s) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}

export async function statement(entries, now, issuer, kid) {
  const subject = [];
  for (const e of entries) subject.push({ name: `aur/${e.pkgbase}`, digest: { sha256: await sha256hex(`aur/${e.pkgbase}`) } });
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject,
    predicateType: PREDICATE_TYPE,
    predicate: {
      observer: issuer,
      source: "https://aur.archlinux.org",
      observed_at: new Date(now * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
      entries,
      signer: { issuer, kid },
    },
  };
}

export async function signBundle(signer, stmt, fetchFn = fetch) {
  const payload = enc.encode(JSON.stringify(stmt));
  const pae = concat(enc.encode(`DSSEv1 ${PAYLOAD_TYPE.length} ${PAYLOAD_TYPE} ${payload.length} `), payload);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.key, pae));
  const sig = ecdsaRawToDer(raw);
  const ts = await timestamp(sig, fetchFn);
  const bundle = {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: {
      publicKey: { hint: signer.hint },
      timestampVerificationData: { rfc3161Timestamps: [{ signedTimestamp: b64(ts.token) }] },
    },
    dsseEnvelope: { payload: b64(payload), payloadType: PAYLOAD_TYPE, signatures: [{ sig: b64(sig) }] },
  };
  return { bundle, time: ts.time };
}
