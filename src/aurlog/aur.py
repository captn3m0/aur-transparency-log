import json
import os
import re
import subprocess
import urllib.parse
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

from . import net

RSS_URL = "https://aur.archlinux.org/rss/modified"
RPC_URL = "https://aur.archlinux.org/rpc/v5/info"
GIT_URL = "https://aur.archlinux.org/{}.git"
PKGBASE_RE = re.compile(r"^[a-z0-9][a-z0-9@._+-]*$")


def parse_rss(body):
    rows = []
    for item in ET.fromstring(body).iter("item"):
        try:
            name = item.findtext("title").strip()
            ts = int(parsedate_to_datetime(item.findtext("pubDate")).timestamp())
        except (AttributeError, TypeError, ValueError):
            continue
        rows.append((name, ts))
    return rows


def rpc_info(names, chunk=50):
    found = {}
    names = sorted(names)
    for i in range(0, len(names), chunk):
        part = names[i : i + chunk]
        query = "&".join("arg[]=" + urllib.parse.quote(n) for n in part)
        body, _ = net.get(f"{RPC_URL}?{query}")
        for res in json.loads(body).get("results", []):
            found[res["Name"]] = (res["PackageBase"], res.get("LastModified"))
    return found


def head(pkgbase, timeout=45):
    if not PKGBASE_RE.match(pkgbase):
        return None
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    cmd = ["git", "ls-remote", GIT_URL.format(pkgbase), "HEAD"]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip()[:200])
    for line in proc.stdout.splitlines():
        sha, _, ref = line.partition("\t")
        if ref == "HEAD" and re.fullmatch(r"[0-9a-f]{40}", sha):
            return sha
    return None
