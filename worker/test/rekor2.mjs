import { readFileSync, writeFileSync } from "node:fs";
import { loadKey, signBundle, statement, REKOR_V2_URL } from "../src/sign.js";

const signer = await loadKey(readFileSync(process.argv[2], "utf8"));
const now = Math.floor(Date.now() / 1000);
const stmt = await statement([{ pkgbase: "rekor-v2-prototype", commit: "0".repeat(40), before: null }], now, "https://captnemo.in/aur-transparency-log", signer.kid);
const { bundle, time } = await signBundle(signer, stmt, { rekorUrl: REKOR_V2_URL });
writeFileSync(process.argv[3], JSON.stringify(bundle, null, 1));
const tle = bundle.verificationMaterial.tlogEntries[0];
console.log("tsa time", time, "logIndex", tle.logIndex, "kind", JSON.stringify(tle.kindVersion), "keys", Object.keys(tle).join(","));
