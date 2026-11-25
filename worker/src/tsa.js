import { fromHex, tlv, readLen } from "./der.js";

const SHA256_ALG = fromHex("300d06096086480165030402010500");
export const TSA_URL = "https://timestamp.sigstore.dev/api/v1/timestamp";

export function buildRequest(digest) {
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  nonce[0] &= 0x7f;
  return tlv(0x30, Uint8Array.of(0x02, 0x01, 0x01), tlv(0x30, SHA256_ALG, tlv(0x04, digest)), tlv(0x02, nonce), Uint8Array.of(0x01, 0x01, 0xff));
}

export function checkGranted(resp) {
  let [, i] = readLen(resp, 1);
  [, i] = readLen(resp, i + 1);
  const status = resp[i + 2];
  if (resp[0] !== 0x30 || status > 1) throw new Error(`tsa status ${status}`);
}

export function genTime(resp) {
  const m = /\x18\x0f(\d{14})Z/.exec(new TextDecoder("latin1").decode(resp));
  if (!m) throw new Error("tsa genTime not found");
  const d = m[1];
  return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10), +d.slice(10, 12), +d.slice(12, 14)) / 1000;
}

export async function timestamp(signature, fetchFn = fetch) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", signature));
  const res = await fetchFn(TSA_URL, { method: "POST", headers: { "Content-Type": "application/timestamp-query" }, body: buildRequest(digest) });
  if (!res.ok) throw new Error(`tsa http ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const resp = new Uint8Array(await res.arrayBuffer());
  checkGranted(resp);
  return { token: resp, time: genTime(resp) };
}
