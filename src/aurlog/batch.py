import hashlib
import json
import os
from datetime import datetime, timezone

from . import OBSERVER, PREDICATE_TYPE, SOURCE


def subject_digest(pkgbase):
    return hashlib.sha256(f"aur/{pkgbase}".encode()).hexdigest()


def predicate(entries, now):
    stamp = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "observer": OBSERVER,
        "source": SOURCE,
        "observed_at": stamp,
        "entries": entries,
    }


def statement(entries, now):
    return {
        "_type": "https://in-toto.io/Statement/v1",
        "subject": [
            {"name": f"aur/{e['pkgbase']}", "digest": {"sha256": subject_digest(e["pkgbase"])}}
            for e in entries
        ],
        "predicateType": PREDICATE_TYPE,
        "predicate": predicate(entries, now),
    }


def write(out_dir, entries, now):
    os.makedirs(out_dir, exist_ok=True)
    stmt = statement(entries, now)
    with open(os.path.join(out_dir, "predicate.json"), "w") as fh:
        json.dump(stmt["predicate"], fh, indent=1)
    with open(os.path.join(out_dir, "statement.json"), "w") as fh:
        json.dump(stmt, fh)
    with open(os.path.join(out_dir, "subjects.txt"), "w") as fh:
        for sub in stmt["subject"]:
            fh.write(f"{sub['digest']['sha256']}  {sub['name']}\n")
