import { handle } from "./api.js";
import { runCycle } from "./observe.js";
import { loadKey } from "./sign.js";

let cached;

// Same logical request, one cache entry: drop tracking params and sort the rest.
function canonical(req) {
  const u = new URL(req.url);
  const q = [...u.searchParams.entries()].filter(([k]) => !k.startsWith("utm_")).sort(([a, x], [b, y]) => (a === b ? x.localeCompare(y) : a.localeCompare(b)));
  u.search = new URLSearchParams(q).toString();
  return new Request(u.toString(), { method: "GET" });
}
const signer = (env) => (cached ??= loadKey(env.SIGNING_KEY));

export default {
  async fetch(req, env, ctx) {
    try {
      const cache = caches.default;
      const key = req.method === "GET" ? canonical(req) : null;
      const hit = key ? await cache.match(key) : null;
      if (hit) return hit;
      const res = await handle(req, env, await signer(env));
      const cc = res.headers.get("Cache-Control") || "";
      if (key && !cc.includes("no-store") && /max-age=[1-9]/.test(cc)) ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    } catch (e) {
      console.log("request failed", e.message);
      return new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      signer(env)
        .then((s) => runCycle(env, s))
        .then((r) => console.log("cycle", JSON.stringify(r)))
        .catch((e) => console.log("cycle crashed", e.message)),
    );
  },
};
