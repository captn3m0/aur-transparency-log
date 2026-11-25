import { signBundle, statement } from "./sign.js";
import { BASE_RE, newest, readJson, recordCycle, writeJson } from "./store.js";

const UA = "aur-transparency-log/0.1 (+https://github.com/captn3m0/aur-transparency-log)";
const RSS_URL = "https://aur.archlinux.org/rss/modified";
const RPC_URL = "https://aur.archlinux.org/rpc/v5/info";
const GIT_URL = (b) => `https://aur.archlinux.org/${b}.git/info/refs?service=git-upload-pack`;

export function parseRss(xml) {
  const rows = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const name = /<title>([^<]*)<\/title>/.exec(m[1])?.[1]?.trim();
    const ts = Math.floor(Date.parse(/<pubDate>([^<]*)<\/pubDate>/.exec(m[1])?.[1]) / 1000);
    if (name && ts) rows.push([name, ts]);
  }
  return rows;
}

export function parseHead(buf) {
  const m = /[0-9a-f]{4}([0-9a-f]{40}) HEAD\0/.exec(new TextDecoder("latin1").decode(buf));
  return m ? m[1] : null;
}

const get = (url, fetchFn, headers = {}) => fetchFn(url, { headers: { "User-Agent": UA, ...headers } });

async function rpcInfo(names, fetchFn) {
  const found = {};
  for (let i = 0; i < names.length; i += 50) {
    const q = names.slice(i, i + 50).map((n) => "arg[]=" + encodeURIComponent(n)).join("&");
    const res = await get(`${RPC_URL}?${q}`, fetchFn);
    if (!res.ok) throw new Error(`rpc http ${res.status}`);
    for (const r of (await res.json()).results || []) found[r.Name] = r.PackageBase;
  }
  return found;
}

async function head(base, fetchFn) {
  const res = await get(GIT_URL(base), fetchFn);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`git http ${res.status}`);
  return parseHead(new Uint8Array(await res.arrayBuffer()));
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).then((v) => [v, null], (e) => [null, e]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  return out;
}

async function fail(env, st, now, stage, msg) {
  console.log(stage, "failed", msg);
  await writeJson(env.BUCKET, "s/state.json", { ...st, last_attempt: now, last_error: `${stage}: ${msg}`.slice(0, 300) });
  return { entries: 0, error: stage };
}

export async function runCycle(env, signer, fetchFn = fetch, now = Math.floor(Date.now() / 1000)) {
  const st = await readJson(env.BUCKET, "s/state.json", { last_ts: 0, etag: null, pending: {} });
  const since = st.last_ts ? st.last_ts - 60 : now - Number(env.LOOKBACK || 1800);
  const names = new Set(Object.keys(st.pending));
  let newestTs = st.last_ts;
  try {
    const res = await get(RSS_URL, fetchFn, st.etag ? { "If-None-Match": st.etag } : {});
    if (res.status === 200) {
      st.etag = res.headers.get("ETag");
      for (const [name, ts] of parseRss(await res.text())) {
        newestTs = Math.max(newestTs, ts);
        if (ts >= since) names.add(name);
      }
    } else if (res.status !== 304) {
      throw new Error(`rss http ${res.status}`);
    }
  } catch (e) {
    return fail(env, st, now, "rss", e.message);
  }
  const list = [...names].filter((n) => BASE_RE.test(n)).sort();
  let bases = Object.fromEntries(list.map((n) => [n, n]));
  try {
    if (list.length) bases = await rpcInfo(list, fetchFn);
  } catch (e) {
    console.log("rpc failed, assuming pkgname == pkgbase", e.message);
  }
  const owner = {};
  for (const [name, base] of Object.entries(bases)) if (BASE_RE.test(base)) owner[base] = name;
  const all = Object.keys(owner).sort();
  const cap = Number(env.MAX_CANDIDATES || 15);
  const work = all.slice(0, cap);
  const pending = {};
  for (const b of all.slice(cap)) pending[owner[b]] = st.pending[owner[b]] || 1;
  const results = await pool(work, 2, async (base) => {
    const sha = await head(base, fetchFn);
    const prev = await newest(env.BUCKET, base);
    return sha && sha !== prev?.commit ? { pkgbase: base, commit: sha, before: prev?.commit ?? null } : null;
  });
  const entries = [];
  results.forEach(([v, err], i) => {
    if (err) {
      const tries = (st.pending[owner[work[i]]] || 0) + 1;
      if (tries < 6) pending[owner[work[i]]] = tries;
      console.log("head check failed", work[i], err.message);
    } else if (v) {
      entries.push(v);
    }
  });
  const headErrors = results.filter(([, e]) => e).map(([, e]) => e.message);
  st.last_head_error = headErrors[0] || null;
  if (entries.length) {
    try {
      const stmt = await statement(entries, now, env.ISSUER, signer.kid);
      const { bundle, time } = await signBundle(signer, stmt, fetchFn);
      const cycle = `${time}-${entries[0].commit.slice(0, 8)}`;
      await recordCycle(env.BUCKET, cycle, bundle, entries, time);
      const fresh = entries.map((x) => ({ pkgbase: x.pkgbase, commit: x.commit, time, bundle: `${env.PUBLIC_BASE}/b/${cycle}.sigstore.json` }));
      st.recent = [...fresh, ...(st.recent || [])].slice(0, 60);
      st.last_cycle = time;
    } catch (e) {
      for (const x of entries) pending[owner[x.pkgbase]] = (st.pending[owner[x.pkgbase]] || 0) + 1;
      return fail(env, { ...st, pending }, now, "sign", e.message);
    }
  }
  await writeJson(env.BUCKET, "s/state.json", { ...st, last_ts: newestTs, pending, last_run: now, last_error: null, last_attempt: now });
  return { entries: entries.length };
}
