const MAX = 9999999999;
export const BASE_RE = /^[a-z0-9][a-z0-9@._+-]{0,127}$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;

export const inv = (ts) => String(MAX - ts).padStart(10, "0");

export function parseKey(key) {
  const [, base, rest] = key.split("/");
  return { base, commit: rest.slice(11), ts: MAX - Number(rest.slice(0, 10)) };
}

const meta = (o) => ({ ...parseKey(o.key), cycle: o.customMetadata?.cycle });

export async function recordCycle(bucket, cycle, bundle, entries, ts) {
  await bucket.put(`b/${cycle}.sigstore.json`, JSON.stringify(bundle), { httpMetadata: { contentType: "application/json" } });
  for (const e of entries) {
    const opts = { customMetadata: { cycle, ts: String(ts) } };
    await bucket.put(`c/${e.pkgbase}/${inv(ts)}-${e.commit}`, "", opts);
    await bucket.put(`k/${e.pkgbase}/${e.commit}`, "", opts);
  }
}

export async function newest(bucket, base) {
  const l = await bucket.list({ prefix: `c/${base}/`, limit: 1, include: ["customMetadata"] });
  return l.objects[0] ? meta(l.objects[0]) : null;
}

export async function atOrBefore(bucket, base, before) {
  const startAfter = `c/${base}/${inv(before + 1)}~`;
  const l = await bucket.list({ prefix: `c/${base}/`, startAfter, limit: 1, include: ["customMetadata"] });
  return l.objects[0] ? meta(l.objects[0]) : null;
}

export async function byCommit(bucket, base, commit) {
  const o = await bucket.head(`k/${base}/${commit}`);
  return o ? { base, commit, ts: Number(o.customMetadata?.ts), cycle: o.customMetadata?.cycle } : null;
}

export async function history(bucket, base, cursor, limit = 100) {
  const l = await bucket.list({ prefix: `c/${base}/`, limit, cursor, include: ["customMetadata"] });
  return { items: l.objects.map(meta), cursor: l.truncated ? l.cursor : null };
}

export async function readJson(bucket, key, fallback) {
  const o = await bucket.get(key);
  return o ? o.json() : fallback;
}

export const writeJson = (bucket, key, v) => bucket.put(key, JSON.stringify(v), { httpMetadata: { contentType: "application/json" } });

export async function shardName(base) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(base)));
  return (d[0] >> 2).toString(16).padStart(2, "0");
}
