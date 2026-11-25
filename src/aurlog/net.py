import time
import urllib.error
import urllib.request

UA = "aur-transparency-log/0.1 (+https://github.com/captn3m0/aur-transparency-log)"
RETRY_CODES = {429, 500, 502, 503, 504}


class NotModified(Exception):
    pass


def get(url, etag=None, timeout=20, tries=4):
    headers = {"User-Agent": UA}
    if etag:
        headers["If-None-Match"] = etag
    last = None
    for attempt in range(tries):
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read(), resp.headers.get("ETag")
        except urllib.error.HTTPError as err:
            if err.code == 304:
                raise NotModified from err
            if err.code not in RETRY_CODES:
                raise
            last = err
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            last = err
        time.sleep(min(2 ** (attempt + 1), 30))
    raise RuntimeError(f"GET {url} failed after {tries} tries: {last}")
