import { handle } from "./api.js";
import { runCycle } from "./observe.js";
import { loadKey } from "./sign.js";

let cached;
const signer = (env) => (cached ??= loadKey(env.SIGNING_KEY));

export default {
  async fetch(req, env, ctx) {
    try {
      const cache = caches.default;
      const hit = req.method === "GET" ? await cache.match(req) : null;
      if (hit) return hit;
      const res = await handle(req, env, await signer(env));
      if (req.method === "GET" && res.status === 200 && /max-age=(?!60\b)/.test(res.headers.get("Cache-Control") || "")) ctx.waitUntil(cache.put(req, res.clone()));
      return res;
    } catch (e) {
      console.log("request failed", e.message);
      return new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } });
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
