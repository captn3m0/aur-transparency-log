import { readJson } from "./store.js";

const COUNTERS = {
  cycles_total: "Observer cycles that wrote state",
  entries_total: "Commits attested",
  bundles_total: "Sigstore bundles written",
  head_checks_total: "Git HEAD checks attempted",
  head_errors_total: "Git HEAD checks that failed",
  head_dropped_total: "Packages dropped after repeated HEAD failures",
  rss_fetches_total: "RSS feed fetches that returned 200",
  rss_items_total: "RSS items parsed",
  rpc_errors_total: "AUR RPC lookups that failed",
  failures_total: "Cycles that failed, by stage",
};

export function bump(st, name, n = 1) {
  st.metrics ??= {};
  st.metrics[name] = (st.metrics[name] || 0) + n;
}

const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

function series(name, type, help, rows) {
  const out = [`# HELP aurtl_${name} ${help}`, `# TYPE aurtl_${name} ${type}`];
  for (const [labels, v] of rows) {
    const l = Object.entries(labels).map(([k, x]) => `${k}="${esc(x)}"`).join(",");
    out.push(`aurtl_${name}${l ? `{${l}}` : ""} ${v}`);
  }
  return out.join("\n");
}

export async function render(env, signer, now) {
  const st = await readJson(env.BUCKET, "s/state.json", null);
  const m = st?.metrics || {};
  const age = st?.last_run ? now - st.last_run : null;
  const g = (name, help, v) => (v === null || v === undefined ? null : series(name, "gauge", help, [[{}, v]]));
  const out = [
    g("up", "1 if the last successful cycle is under 15 minutes old", age !== null && age < 900 ? 1 : 0),
    g("last_run_timestamp_seconds", "Last successful cycle", st?.last_run),
    g("last_attempt_timestamp_seconds", "Last cycle attempt", st?.last_attempt),
    g("last_run_age_seconds", "Seconds since the last successful cycle", age),
    g("last_bundle_timestamp_seconds", "TSA time of the newest bundle", st?.last_cycle),
    g("last_bundle_age_seconds", "Seconds since the newest bundle", st?.last_cycle ? now - st.last_cycle : null),
    g("rss_newest_timestamp_seconds", "Newest pubDate seen in the RSS feed", st?.last_ts),
    g("rss_lag_seconds", "Seconds between now and the newest RSS item", st?.last_ts ? now - st.last_ts : null),
    g("pending_packages", "Packages waiting for a retry or over the cycle cap", Object.keys(st?.pending || {}).length),
    g("pending_max_tries", "Highest retry count among pending packages", Math.max(0, ...Object.values(st?.pending || {}))),
    g("recent_entries", "Entries listed in /v1/recent", (st?.recent || []).length),
    g("last_error", "1 if the last cycle failed", st?.last_error ? 1 : 0),
    g("last_head_error", "1 if the last cycle had a HEAD check failure", st?.last_head_error ? 1 : 0),
    g("last_cycle_entries", "Commits attested in the last written cycle", st?.last_entries),
    g("last_cycle_candidates", "HEAD checks in the last written cycle", st?.last_candidates),
    g("last_cycle_duration_seconds", "Wall time of the last written cycle", st?.last_duration),
    g("state_present", "1 if s/state.json exists", st ? 1 : 0),
    series("config", "gauge", "Numeric worker settings", [
      [{ name: "gran" }, Number(env.GRAN || 3600)],
      [{ name: "max_candidates" }, Number(env.MAX_CANDIDATES || 15)],
      [{ name: "lookback" }, Number(env.LOOKBACK || 1800)],
      [{ name: "tsa_min" }, Number(env.TSA_MIN || 1)],
      [{ name: "tsa_urls" }, env.TSA_URLS ? env.TSA_URLS.split(",").length : 1],
    ]),
    series("signing_key_info", "gauge", "Active signing key", [[{ kid: signer.kid, hint: signer.hint }, 1]]),
    series("build_info", "gauge", "Worker settings as labels", [[{ issuer: env.ISSUER || "", rekor: env.REKOR_URL || "", tsa: env.TSA_URLS || "" }, 1]]),
  ];
  for (const [name, help] of Object.entries(COUNTERS)) {
    if (name === "failures_total") {
      const stages = ["rss", "sign"].map((s) => [{ stage: s }, m[`failures_${s}`] || 0]);
      out.push(series(name, "counter", help, stages));
    } else {
      out.push(series(name, "counter", help, [[{}, m[name] || 0]]));
    }
  }
  return out.filter(Boolean).join("\n") + "\n";
}

// Grafana Cloud only scrapes endpoints behind auth, so any bearer or basic credential is accepted.
export const authorized = (req) => /^(basic|bearer)\s+\S+/i.test(req.headers.get("Authorization") || "");
