export const enc = new TextEncoder();

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function b64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const fromHex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
export const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
export const b64u = (u8) => b64(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64u = (s) => fromB64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));

export function tlv(tag, ...body) {
  const content = concat(...body);
  const n = content.length;
  const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
  return concat(Uint8Array.of(tag, ...len), content);
}

export function derInt(x) {
  let i = 0;
  while (i < x.length - 1 && x[i] === 0) i++;
  let v = x.subarray(i);
  if (v[0] & 0x80) v = concat(Uint8Array.of(0), v);
  return tlv(0x02, v);
}

export const ecdsaRawToDer = (sig) => tlv(0x30, derInt(sig.subarray(0, 32)), derInt(sig.subarray(32)));

export function readLen(buf, i) {
  const b = buf[i];
  if (b < 128) return [b, i + 1];
  const n = b & 0x7f;
  let len = 0;
  for (let k = 0; k < n; k++) len = len * 256 + buf[i + 1 + k];
  return [len, i + 1 + n];
}
