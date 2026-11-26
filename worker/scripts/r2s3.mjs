import { createHash, createHmac } from "node:crypto";

const hmac = (k, m) => createHmac("sha256", k).update(m).digest();
const hex = (b) => createHash("sha256").update(b).digest("hex");
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export class S3Bucket {
  constructor({ account, bucket, keyId, secret }) {
    this.host = `${account}.r2.cloudflarestorage.com`;
    this.bucket = bucket;
    this.keyId = keyId;
    this.secret = secret;
  }

  async request(method, key, body = "", headers = {}, query = {}) {
    const payload = Buffer.from(body);
    const now = new Date().toISOString().replace(/[-:]|\.\d+/g, "");
    const day = now.slice(0, 8);
    const path = key === null ? `/${this.bucket}` : `/${this.bucket}/${key.split("/").map(enc).join("/")}`;
    const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join("&");
    const h = { host: this.host, "x-amz-content-sha256": hex(payload), "x-amz-date": now, ...headers };
    const names = Object.keys(h).map((k) => k.toLowerCase()).sort();
    const canon = [method, path, qs, ...names.map((n) => `${n}:${String(h[Object.keys(h).find((k) => k.toLowerCase() === n)]).trim()}`), "", names.join(";"), h["x-amz-content-sha256"]].join("\n");
    const scope = `${day}/auto/s3/aws4_request`;
    const sts = ["AWS4-HMAC-SHA256", now, scope, hex(canon)].join("\n");
    const sig = createHmac("sha256", hmac(hmac(hmac(hmac("AWS4" + this.secret, day), "auto"), "s3"), "aws4_request")).update(sts).digest("hex");
    h.authorization = `AWS4-HMAC-SHA256 Credential=${this.keyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}`;
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`https://${this.host}${path}${qs ? "?" + qs : ""}`, { method, headers: h, body: method === "GET" || method === "HEAD" || method === "DELETE" ? undefined : payload });
      if (res.status < 500 && res.status !== 429) return res;
      await new Promise((ok) => setTimeout(ok, 500 * 2 ** i));
    }
    throw new Error(`${method} ${key}: too many retries`);
  }

  async put(key, value, opts = {}) {
    const h = { "content-type": opts.httpMetadata?.contentType || "application/octet-stream" };
    for (const [k, v] of Object.entries(opts.customMetadata || {})) h[`x-amz-meta-${k}`] = v;
    const res = await this.request("PUT", key, value, h);
    if (!res.ok) throw new Error(`PUT ${key}: ${res.status} ${(await res.text()).slice(0, 150)}`);
  }

  async head(key) {
    const res = await this.request("HEAD", key);
    return res.ok ? { cycle: res.headers.get("x-amz-meta-cycle"), ts: res.headers.get("x-amz-meta-ts") } : null;
  }

  async del(key) {
    const res = await this.request("DELETE", key);
    if (!res.ok && res.status !== 404) throw new Error(`DELETE ${key}: ${res.status}`);
  }

  async listKeys(prefix) {
    const keys = [];
    let token;
    do {
      const q = { "list-type": "2", prefix, "max-keys": "1000", ...(token ? { "continuation-token": token } : {}) };
      const res = await this.request("GET", null, "", {}, q);
      if (!res.ok) throw new Error(`LIST ${prefix}: ${res.status}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(m[1].replace(/&amp;/g, "&"));
      token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
    } while (token);
    return keys;
  }
}
