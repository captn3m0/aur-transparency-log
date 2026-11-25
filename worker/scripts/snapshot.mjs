import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { loadKey, signBundle, REKOR_V2_URL } from "../src/sign.js";
import { parseHead } from "../src/observe.js";

const UA = "aur-transparency-log/0.1 (+https://github.com/captn3m0/aur-transparency-log)";
const META = "https://aur.archlinux.org/packages-meta-ext-v1.json.gz";
const MIRROR = "https://github.com/archlinux/aur.git";
const BASE = "https://aur-tl.captnemo.in";
const ISSUER = "https://captnemo.in/aur-transparency-log";
const PRED = "https://captnemo.in/aur-transparency-log/aur-snapshot/v1";
const SAMPLE = Number(process.env.SAMPLE || 150);
const upload = process.argv.includes("--upload");
const sha = (b) => createHash("sha256").update(b).digest("hex");

const res = await fetch(META, { headers: { "User-Agent": UA } });
if (!res.ok) throw new Error(`meta http ${res.status}`);
const metaTs = Math.floor(Date.parse(res.headers.get("last-modified")) / 1000);
const meta = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())));
const mods = new Map();
for (const p of meta) mods.set(p.PackageBase, Math.max(mods.get(p.PackageBase) || 0, p.LastModified));
console.log("meta packages", meta.length, "pkgbases", mods.size, "generated", metaTs);

const mirror = new Map();
for (const line of execFileSync("git", ["ls-remote", "--heads", MIRROR], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\n")) {
  const [h, ref] = line.split("\t");
  if (ref?.startsWith("refs/heads/")) mirror.set(ref.slice(11), h);
}
console.log("mirror heads", mirror.size);

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

const names = [...mods.keys()].sort();
const recheck = new Set(names.filter((n) => !mirror.has(n) || mods.get(n) >= metaTs - 3600));
const rnd = names.filter((n) => !recheck.has(n));
for (let i = 0; i < SAMPLE && rnd.length; i++) recheck.add(rnd.splice(Math.floor(Math.random() * rnd.length), 1)[0]);
const verified = { rechecked: 0, differing: 0, missing_on_mirror: 0 };
const heads = new Map(mirror);
const queue = [...recheck];
await Promise.all(Array.from({ length: 2 }, async () => {
  while (queue.length) {
    const n = queue.pop();
    const h = await origin(n);
    verified.rechecked++;
    if (!mirror.has(n)) verified.missing_on_mirror++;
    else if (h && h !== mirror.get(n)) verified.differing++;
    if (h) heads.set(n, h);
  }
}));
console.log("verified", verified);

const shardOf = (n) => (createHash("sha256").update(n).digest()[0] >> 2).toString(16).padStart(2, "0");
const shards = {};
let count = 0;
for (const n of names) {
  const h = heads.get(n);
  if (!h) continue;
  (shards[shardOf(n)] ||= []).push([n, h, mods.get(n)]);
  count++;
}
const id = String(metaTs);
const dir = `.tmp/snapshot/${id}`;
mkdirSync(dir, { recursive: true });
const hashes = {};
for (const k of Object.keys(shards).sort()) {
  const body = JSON.stringify({ entries: shards[k] });
  writeFileSync(`${dir}/${k}.json`, body);
  hashes[k] = sha(body);
}
const manifestDigest = sha(JSON.stringify(hashes));
const pem = process.env.SIGNING_KEY || execFileSync("pass", ["show", "Nebula/aur-tl/SIGNING_KEY"], { encoding: "utf8" });
const signer = await loadKey(pem);
const stmt = {
  _type: "https://in-toto.io/Statement/v1",
  subject: [{ name: `aur-snapshot/${id}`, digest: { sha256: manifestDigest } }],
  predicateType: PRED,
  predicate: {
    observer: ISSUER,
    taken_at: new Date(metaTs * 1000).toISOString().replace(".000Z", "Z"),
    source: { meta: META, meta_last_modified: metaTs, heads: MIRROR, rechecked_on: "https://aur.archlinux.org" },
    count,
    verified,
    shard_count: Object.keys(hashes).length,
    shard_sha256: hashes,
    signer: { issuer: ISSUER, kid: signer.kid },
  },
};
const { bundle, time } = await signBundle(signer, stmt, { rekorUrl: REKOR_V2_URL });
writeFileSync(`${dir}/bundle.sigstore.json`, JSON.stringify(bundle));
const manifest = { id, taken_at: time, meta_last_modified: metaTs, count, shards: Object.keys(hashes).length, bundle: `${BASE}/snapshot/${id}/bundle.sigstore.json`, shard_url: `${BASE}/snapshot/${id}/{shard}.json` };
writeFileSync(`.tmp/snapshot/latest.json`, JSON.stringify(manifest));
console.log("signed", { count, shards: manifest.shards, tsa_time: time, logIndex: bundle.verificationMaterial.tlogEntries[0].logIndex });

if (upload) {
  const files = [...Object.keys(hashes).map((k) => [`snapshot/${id}/${k}.json`, `${dir}/${k}.json`]), [`snapshot/${id}/bundle.sigstore.json`, `${dir}/bundle.sigstore.json`]];
  const put = (key, file) => new Promise((ok, fail) => {
    const p = spawn("npx", ["--yes", "wrangler@4", "r2", "object", "put", `aur-tl/${key}`, "--file", file, "--content-type", "application/json", "--remote"], { stdio: "ignore" });
    p.on("exit", (c) => (c ? fail(new Error(`${key}: exit ${c}`)) : ok()));
  });
  const q = [...files];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (q.length) { const [k, f] = q.pop(); await put(k, f); }
  }));
  await put("snapshot/latest.json", ".tmp/snapshot/latest.json");
  console.log("uploaded", files.length + 1, "objects");
}
