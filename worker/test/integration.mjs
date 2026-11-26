import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { handle } from "../src/api.js";
import { runCycle } from "../src/observe.js";
import { loadKey } from "../src/sign.js";

class Bucket {
  m = new Map();
  async put(k, v, o = {}) { this.m.set(k, { v: String(v), o }); }
  async get(k) { const e = this.m.get(k); return e && { body: e.v, json: async () => JSON.parse(e.v), text: async () => e.v }; }
  async head(k) { const e = this.m.get(k); return e && { customMetadata: e.o.customMetadata }; }
  async list({ prefix = "", startAfter = "", limit = 1000 }) {
    const keys = [...this.m.keys()].filter((k) => k.startsWith(prefix) && k > startAfter).sort();
    return { objects: keys.slice(0, limit).map((key) => ({ key, customMetadata: this.m.get(key).o.customMetadata })), truncated: keys.length > limit, cursor: null };
  }
}

const env = { BUCKET: new Bucket(), ISSUER: "https://captnemo.in/aur-transparency-log", PUBLIC_BASE: "https://aur-tl.captnemo.in", GRAN: "1", MAX_CANDIDATES: "4", LOOKBACK: "1800" };
const signer = await loadKey(process.env.SIGNING_KEY || execFileSync("pass", ["show", "Nebula/aur-tl/SIGNING_KEY"], { encoding: "utf8" }));
console.log("kid", signer.kid);
const r = await runCycle(env, signer);
console.log("cycle", r);
const state = JSON.parse((await env.BUCKET.get("s/state.json")).body);
console.log("state", { last_ts: state.last_ts, pending: Object.keys(state.pending).length });
const keys = [...env.BUCKET.m.keys()];
console.log("objects", keys.length, keys.filter((k) => k.startsWith("b/")));
const bundleKey = keys.find((k) => k.startsWith("b/"));
const bundle = JSON.parse((await env.BUCKET.get(bundleKey)).body);
writeFileSync(".tmp/worker.bundle.json", JSON.stringify(bundle));
const stmt = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64"));
const e = stmt.predicate.entries[0];
writeFileSync(".tmp/worker.subject", `aur/${e.pkgbase}`);
console.log("entry", e.pkgbase, e.commit);
const now = Math.floor(Date.now() / 1000);
const call = async (p) => (await handle(new Request("https://aur-tl.captnemo.in" + p), env, signer, now)).json();
console.log("pkg", await call(`/v1/pkg/${e.pkgbase}?before=${now + 5}`));
console.log("too_new", await call(`/v1/pkg/${e.pkgbase}?before=${now - 3600}`));
console.log("none", await call(`/v1/pkg/zzz-not-real?before=${now}`));
console.log("commit", await call(`/v1/pkg/${e.pkgbase}/commit/${e.commit}`));
console.log("history", JSON.stringify(await call(`/v1/pkg/${e.pkgbase}/history`)).slice(0, 200));
console.log("keys", (await call("/v1/keys")).keys[0].kid);
console.log("health", await call("/healthz"));
console.log("metrics", (await (await handle(new Request("https://aur-tl.captnemo.in/metrics"), env, signer, now)).text()).split("\n").filter((l) => l && !l.startsWith("#")).join(" | "));
