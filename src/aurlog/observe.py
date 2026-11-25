import os
import time
from concurrent.futures import ThreadPoolExecutor

from . import aur, batch, net, state

LOOKBACK = 1800
SLACK = 60
MAX_ENTRIES = 500
MAX_ATTEMPTS = 6
CONCURRENCY = 2


def warn(msg):
    print(f"::warning::{msg}", flush=True)


def candidates(st, now):
    since = st["last_ts"] - SLACK if st["last_ts"] else now - LOOKBACK
    names = set(st["pending"])
    newest = st["last_ts"]
    try:
        body, etag = net.get(aur.RSS_URL, etag=st["etag"])
        st["etag"] = etag
        for name, ts in aur.parse_rss(body):
            newest = max(newest, ts)
            if ts >= since:
                names.add(name)
    except net.NotModified:
        pass
    except Exception as err:
        warn(f"rss fetch failed: {err}")
        return names, st["last_ts"]
    return names, newest


def resolve(names):
    try:
        info = aur.rpc_info(names)
    except Exception as err:
        warn(f"rpc lookup failed, assuming pkgname == pkgbase: {err}")
        return {n: (n, None) for n in names}
    return info


def check(base):
    try:
        return aur.head(base), None
    except Exception as err:
        return None, err


def observe(state_dir, out_dir, now=None, profile=batch.DEFAULT):
    now = int(now or time.time())
    path = os.path.join(state_dir, "state.json")
    st = state.load(path)
    names, newest = candidates(st, now)
    bases = {}
    for name, (base, mod) in resolve(names).items():
        bases[base] = (name, mod)
    ordered = sorted(bases)
    with ThreadPoolExecutor(CONCURRENCY) as pool:
        results = list(pool.map(check, ordered))
    entries, pending = [], {}
    for base, (sha, err) in zip(ordered, results):
        name, mod = bases[base]
        if err is not None:
            tries = st["pending"].get(name, 0) + 1
            if tries < MAX_ATTEMPTS:
                pending[name] = tries
            warn(f"head check failed for {base}: {err}")
        elif sha and sha != st["heads"].get(base):
            entries.append(
                {"pkgbase": base, "commit": sha, "before": st["heads"].get(base), "modified_ts": mod}
            )
    for extra in entries[MAX_ENTRIES:]:
        pending[bases[extra["pkgbase"]][0]] = 1
    entries = entries[:MAX_ENTRIES]
    nxt = {
        "last_ts": newest,
        "etag": st["etag"],
        "heads": {**st["heads"], **{e["pkgbase"]: e["commit"] for e in entries}},
        "pending": pending,
    }
    if not entries:
        state.save(path, nxt)
        return []
    batch.write(out_dir, entries, now, profile)
    state.save(path + ".next", nxt)
    return entries


def commit(state_dir):
    path = os.path.join(state_dir, "state.json")
    if os.path.exists(path + ".next"):
        os.replace(path + ".next", path)
        return True
    return False
