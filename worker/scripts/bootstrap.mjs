import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { parseHead } from "../src/observe.js";
import { loadKey, signBundle, statement, REKOR_V2_URL } from "../src/sign.js";
import { inv } from "../src/store.js";
import { S3Bucket } from "./r2s3.mjs";

const UA = "aur-transparency-log/0.1 (+https://github.com/captn3m0/aur-transparency-log)";
const META = "https://aur.archlinux.org/packages-meta-ext-v1.json.gz";
const MIRROR = "https://github.com/archlinux/aur.git";
const ISSUER = "https://captnemo.in/aur-transparency-log";
const BATCH = Number(process.env.BATCH || 250);
const SAMPLE = Number(process.env.SAMPLE || 150);
const pool = async (items, n, fn) => {
  const q = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); }));
};

const res = await fetch(META, { headers: { "User-Agent": UA } });
if (!res.ok) throw new Error(`meta http ${res.status}`);
const metaTs = Math.floor(Date.parse(res.headers.get("last-modified")) / 1000);
const names = [...new Set(JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer()))).map((p) => p.PackageBase))].sort();
const mods = new Map();
console.log("pkgbases", names.length, "meta generated", metaTs);

const mirror = new Map();
for (const line of execFileSync("git", ["ls-remote", "--heads", MIRROR], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\n")) {
  const [h, ref] = line.split("\t");
  if (ref?.startsWith("refs/heads/")) mirror.set(ref.slice(11), h);
}

const origin = async (base) => {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`https://aur.archlinux.org/${base}.git/info/refs?service=git-upload-pack`, { headers: { "User-Agent": UA } });
      if (r.ok) return parseHead(new Uint8Array(await r.arrayBuffer()));
    } catch {}
    await new Promise((ok) => setTimeout(ok, 1500 * (i + 1)));
  }
  throw new Error(`origin check failed for ${base}`);
};

const recheck = new Set(names.filter((n) => !mirror.has(n)));
const rest = names.filter((n) => !recheck.has(n));
for (let i = 0; i < SAMPLE && rest.length; i++) recheck.add(rest.splice(Math.floor(Math.random() * rest.length), 1)[0]);
const heads = new Map(mirror);
const stats = { rechecked: 0, differing: 0, missing_on_mirror: 0 };
await pool([...recheck], 2, async (n) => {
  const h = await origin(n);
  stats.rechecked++;
  if (!mirror.has(n)) stats.missing_on_mirror++;
  else if (h && h !== mirror.get(n)) stats.differing++;
  if (h) heads.set(n, h);
});
console.log("verified", stats);

const bucket = new S3Bucket({ account: "34c97bfc648a63e10eb2a368ad302011", bucket: "aur-tl", keyId: process.env.R2_KEY_ID, secret: process.env.R2_SECRET });
const written = new Set((await bucket.listKeys("k/")).map((k) => k.slice(2).replace("/", "@")));
console.log("already in R2", written.size);
const key = (e) => `${e.pkgbase}@${e.commit}`;
const all = names.filter((n) => heads.has(n)).map((n) => ({ pkgbase: n, commit: heads.get(n), before: null }));
const entries = all.filter((e) => !written.has(key(e)));
const batches = [];
for (let i = 0; i < entries.length; i += BATCH) batches.push(entries.slice(i, i + BATCH));
console.log("entries", all.length, "to write", entries.length, "batches", batches.length);

const signer = await loadKey(process.env.SIGNING_KEY || execFileSync("pass", ["show", "Nebula/aur-tl/SIGNING_KEY"], { encoding: "utf8" }));
let finished = 0;
const retry = async (fn) => {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= 4) throw e;
      console.log("retrying after", e.cause?.code || e.message);
      await new Promise((ok) => setTimeout(ok, 3000 * 2 ** i));
    }
  }
};
await pool(batches.map((b, i) => i), 4, async (i) => {
  const list = batches[i];
  const stmt = await statement(list, Math.floor(Date.now() / 1000), ISSUER, signer.kid);
  const { bundle, time } = await retry(() => signBundle(signer, stmt, { rekorUrl: REKOR_V2_URL }));
  const cycle = `${time}-${list[0].commit.slice(0, 8)}`;
  await retry(() => bucket.put(`b/${cycle}.sigstore.json`, JSON.stringify(bundle), { httpMetadata: { contentType: "application/json" } }));
  const opts = { customMetadata: { cycle, ts: String(time) } };
  await pool(list, 24, async (e) => {
    await retry(() => bucket.put(`c/${e.pkgbase}/${inv(time)}-${e.commit}`, "", opts));
    await retry(() => bucket.put(`k/${e.pkgbase}/${e.commit}`, "", opts));
  });
  for (const e of list) written.add(key(e));
  if (++finished % 10 === 0) console.log("batches done", finished, "/", batches.length);
});
console.log("bootstrap complete", { entries: all.length, written: written.size, verified: stats });
