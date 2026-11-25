import hashlib
import json
import os
from datetime import datetime, timezone

from . import KEY_ISSUER, KEY_PREDICATE_TYPE, OBSERVER, PREDICATE_TYPE, SOURCE

DEFAULT = {"predicate_type": PREDICATE_TYPE, "observer": OBSERVER}


def subject_digest(pkgbase):
    return hashlib.sha256(f"aur/{pkgbase}".encode()).hexdigest()


def key_profile(kid):
    return {
        "predicate_type": KEY_PREDICATE_TYPE,
        "observer": KEY_ISSUER,
        "signer": {"issuer": KEY_ISSUER, "kid": kid},
    }


def predicate(entries, now, profile=DEFAULT):
    stamp = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    pred = {
        "observer": profile["observer"],
        "source": SOURCE,
        "observed_at": stamp,
        "entries": entries,
    }
    if "signer" in profile:
        pred["signer"] = profile["signer"]
    return pred


def statement(entries, now, profile=DEFAULT):
    return {
        "_type": "https://in-toto.io/Statement/v1",
        "subject": [
            {"name": f"aur/{e['pkgbase']}", "digest": {"sha256": subject_digest(e["pkgbase"])}}
            for e in entries
        ],
        "predicateType": profile["predicate_type"],
        "predicate": predicate(entries, now, profile),
    }


def write(out_dir, entries, now, profile=DEFAULT):
    os.makedirs(out_dir, exist_ok=True)
    stmt = statement(entries, now, profile)
    with open(os.path.join(out_dir, "predicate.json"), "w") as fh:
        json.dump(stmt["predicate"], fh, indent=1)
    with open(os.path.join(out_dir, "statement.json"), "w") as fh:
        json.dump(stmt, fh)
    with open(os.path.join(out_dir, "subjects.txt"), "w") as fh:
        for sub in stmt["subject"]:
            fh.write(f"{sub['digest']['sha256']}  {sub['name']}\n")
