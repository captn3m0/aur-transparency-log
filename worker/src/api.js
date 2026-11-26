import { BASE_RE, COMMIT_RE, atOrBefore, byCommit, history, newest, readJson } from "./store.js";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };

function json(obj, status = 200, cache = "public, max-age=300") {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": cache, ...CORS } });
}

const FOREVER = "public, max-age=31536000, immutable";
const DAY = "public, max-age=86400";

const bundleUrl = (env, cycle) => `${env.PUBLIC_BASE}/b/${cycle}.sigstore.json`;

async function lookup(env, base, before, now) {
  if (!BASE_RE.test(base)) return { pkgbase: base, status: "invalid_pkgbase" };
  const hit = await atOrBefore(env.BUCKET, base, before);
  if (hit) return { pkgbase: base, status: "ok", commit: hit.commit, time: hit.ts, bundle: bundleUrl(env, hit.cycle) };
  const latest = await newest(env.BUCKET, base);
  if (latest) return { pkgbase: base, status: "too_new", newest_time: latest.ts };
  return { pkgbase: base, status: "not_observed" };
}

// A cutoff older than two hours can no longer gain entries: new entries are stamped with the current time.
const settled = (before, now) => before <= now - 7200;

function lookupCache(r, before, now) {
  if (r.status === "ok" && settled(before, now)) return FOREVER;
  return settled(before, now) ? "public, max-age=3600" : "public, max-age=300";
}

const pem = (spki) => `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...spki)).replace(/(.{64})(?=.)/g, "$1\n")}\n-----END PUBLIC KEY-----\n`;

export async function handle(req, env, signer, now = Math.floor(Date.now() / 1000)) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const gran = Number(env.GRAN || 3600);
  let m;
  if (path === "/") return json({ name: "aur-transparency-log", docs: "https://captnemo.in/aur-transparency-log/", endpoints: ["/v1/pkg/{pkgbase}?before=", "/v1/pkg/{pkgbase}/commit/{sha}", "/v1/pkg/{pkgbase}/history", "/v1/batch?before=&pkg=", "/v1/recent", "/v1/keys", "/v1/keys.pem", "/healthz"] });
  if (path === "/healthz") {
    const st = await readJson(env.BUCKET, "s/state.json", null);
    const age = st?.last_run ? now - st.last_run : null;
    return json({ ok: age !== null && age < 900, last_run: st?.last_run ?? null, age, last_attempt: st?.last_attempt ?? null, last_error: st?.last_error ?? null, last_head_error: st?.last_head_error ?? null }, 200, "no-store");
  }
  if (path === "/v1/recent") {
    const st = await readJson(env.BUCKET, "s/state.json", null);
    return json({ items: st?.recent ?? [] }, 200, "public, max-age=60");
  }
  if (path === "/v1/keys") return json({ issuer: env.ISSUER, keys: [{ ...signer.jwk, hint: signer.hint, pem: pem(signer.spki) }] }, 200, DAY);
  if (path === "/v1/keys.pem") return new Response(pem(signer.spki), { headers: { "Content-Type": "application/x-pem-file", "Cache-Control": DAY, ...CORS } });
  if (path === "/jwks.json") return json({ keys: [signer.jwk] }, 200, DAY);
  if (path === "/.well-known/openid-configuration") {
    return json({ issuer: env.ISSUER, jwks_uri: `${env.PUBLIC_BASE}/jwks.json`, response_types_supported: ["id_token"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["ES256"] }, 200, DAY);
  }
  if (path.startsWith("/b/")) {
    const m = /^\/b\/([0-9]+-[0-9a-f]{8})\.sigstore\.json$/.exec(path);
    const obj = m && (await env.BUCKET.get(`b/${m[1]}.sigstore.json`));
    if (!obj) return json({ error: "not found" }, 404);
    return new Response(obj.body, { headers: { "Content-Type": "application/json", "Cache-Control": FOREVER, ...CORS } });
  }
  if ((m = /^\/v1\/pkg\/([^/]+)\/commit\/([^/]+)$/.exec(path))) {
    if (!BASE_RE.test(m[1]) || !COMMIT_RE.test(m[2])) return json({ error: "invalid pkgbase or commit" }, 400);
    const hit = await byCommit(env.BUCKET, m[1], m[2]);
    if (!hit) return json({ pkgbase: m[1], commit: m[2], status: "not_observed" }, 404, "public, max-age=60");
    return json({ pkgbase: m[1], commit: m[2], status: "ok", time: hit.ts, bundle: bundleUrl(env, hit.cycle) }, 200, FOREVER);
  }
  if ((m = /^\/v1\/pkg\/([^/]+)\/history$/.exec(path))) {
    if (!BASE_RE.test(m[1])) return json({ error: "invalid pkgbase" }, 400);
    const h = await history(env.BUCKET, m[1], url.searchParams.get("cursor") || undefined);
    const items = h.items.map((i) => ({ commit: i.commit, time: i.ts, bundle: bundleUrl(env, i.cycle) }));
    return json({ pkgbase: m[1], status: items.length ? "ok" : "not_observed", items, cursor: h.cursor }, 200, "public, max-age=300");
  }
  const single = /^\/v1\/pkg\/([^/]+)$/.exec(path);
  if (single || path === "/v1/batch") {
    const before = Number(url.searchParams.get("before"));
    if (!Number.isInteger(before) || before <= 0) return json({ error: "before=<unix seconds> required" }, 400);
    if (before % gran) return json({ error: `before must be a multiple of ${gran}`, suggest: before - (before % gran) }, 400, "no-store");
    if (single) {
      const r = await lookup(env, single[1], before, now);
      return json(r, 200, lookupCache(r, before, now));
    }
    const pkgs = [...new Set(url.searchParams.getAll("pkg"))].sort().slice(0, 50);
    const results = await Promise.all(pkgs.map((p) => lookup(env, p, before, now)));
    const all = results.every((r) => r.status === "ok") && settled(before, now);
    return json({ before, results, bundles: [...new Set(results.filter((r) => r.bundle).map((r) => r.bundle))] }, 200, all ? FOREVER : lookupCache({}, before, now));
  }
  return json({ error: "not found", hint: "try /v1/pkg/<pkgbase>/history, /v1/pkg/<pkgbase>?before=<unix>, /v1/recent or /" }, 404);
}
