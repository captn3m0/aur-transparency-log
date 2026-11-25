import json
import os

MAX_HEADS = 20000


def load(path):
    try:
        with open(path) as fh:
            data = json.load(fh)
        return {
            "last_ts": int(data.get("last_ts", 0)),
            "etag": data.get("etag"),
            "heads": dict(data.get("heads", {})),
            "pending": dict(data.get("pending", {})),
        }
    except (OSError, ValueError, TypeError):
        return {"last_ts": 0, "etag": None, "heads": {}, "pending": {}}


def save(path, st):
    heads = st["heads"]
    if len(heads) > MAX_HEADS:
        st["heads"] = dict(list(heads.items())[-MAX_HEADS:])
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(st, fh)
    os.replace(tmp, path)
