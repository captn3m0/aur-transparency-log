import { readFileSync, writeFileSync } from "node:fs";
import { loadKey, signBundle, statement } from "../src/sign.js";

const urls = process.argv[4].split(",");
const signer = await loadKey(readFileSync(process.argv[2], "utf8"));
const stmt = await statement([{ pkgbase: "tsa-multi-prototype", commit: "1".repeat(40), before: null }], Math.floor(Date.now() / 1000), "https://captnemo.in/aur-transparency-log", signer.kid);
const r = await signBundle(signer, stmt, { tsaUrls: urls, tsaMin: 1 });
writeFileSync(process.argv[3], JSON.stringify(r.bundle));
console.log("tokens", r.bundle.verificationMaterial.timestampVerificationData.rfc3161Timestamps.length, "time", r.time, "errors", r.tsaErrors);
