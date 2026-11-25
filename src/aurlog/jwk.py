import base64
import hashlib
import json

EC_P256_PREFIX = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d030107034200")


def b64u(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def from_pem(path):
    with open(path) as fh:
        body = "".join(l for l in fh.read().splitlines() if not l.startswith("-----"))
    der = base64.b64decode(body)
    if not der.startswith(EC_P256_PREFIX) or len(der) != len(EC_P256_PREFIX) + 65:
        raise ValueError("not an ECDSA P-256 public key")
    point = der[len(EC_P256_PREFIX) :]
    if point[0] != 4:
        raise ValueError("compressed points are not supported")
    jwk = {"kty": "EC", "crv": "P-256", "x": b64u(point[1:33]), "y": b64u(point[33:])}
    return {**jwk, "kid": thumbprint(jwk), "use": "sig", "alg": "ES256"}


def thumbprint(jwk):
    canon = json.dumps({k: jwk[k] for k in ("crv", "kty", "x", "y")}, separators=(",", ":"), sort_keys=True)
    return b64u(hashlib.sha256(canon.encode()).digest())


def discovery(issuer):
    return {
        "issuer": issuer,
        "jwks_uri": f"{issuer}/jwks.json",
        "response_types_supported": ["id_token"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["ES256"],
    }


def publish(pub_paths, issuer, out_dir):
    import os

    keys = [from_pem(p) for p in pub_paths]
    os.makedirs(os.path.join(out_dir, ".well-known"), exist_ok=True)
    with open(os.path.join(out_dir, "jwks.json"), "w") as fh:
        json.dump({"keys": keys}, fh, indent=1)
    with open(os.path.join(out_dir, ".well-known", "openid-configuration"), "w") as fh:
        json.dump(discovery(issuer), fh, indent=1)
    return keys
