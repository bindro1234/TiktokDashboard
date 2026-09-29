// Cloudflare Access JWT validation. The Worker does not trust that Access sits in front of it:
// every request must carry a valid Cf-Access-Jwt-Assertion, signed by the team's Access keys
// (RS256), for this application's AUD, issued by the team domain and not expired.

const CERT_TTL_MS = 10 * 60 * 1000;
let certCache = { url: null, at: 0, keys: [] };

const b64urlBytes = (s) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function accessKeys(teamDomain, fetchImpl, force = false) {
  const url = `${teamDomain}/cdn-cgi/access/certs`;
  if (!force && certCache.url === url && Date.now() - certCache.at < CERT_TTL_MS) return certCache.keys;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const { keys = [] } = await res.json();
  certCache = { url, at: Date.now(), keys };
  return keys;
}

export class AccessError extends Error {}

/**
 * Returns the verified token payload ({ email, ... }) or throws AccessError.
 * teamDomain: "https://<team>.cloudflareaccess.com"; aud: the Access application's AUD tag.
 */
export async function verifyAccess(request, { teamDomain, aud }, fetchImpl = fetch, nowSec = Date.now() / 1000) {
  if (!teamDomain || !aud) throw new AccessError("Access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD)");
  teamDomain = teamDomain.replace(/\/+$/, "");
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new AccessError("no Access token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessError("malformed token");
  let header, payload;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch {
    throw new AccessError("malformed token");
  }
  if (header.alg !== "RS256") throw new AccessError("unexpected algorithm");

  let keys = await accessKeys(teamDomain, fetchImpl);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await accessKeys(teamDomain, fetchImpl, true); // keys rotate
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new AccessError("unknown signing key");
  const key = await crypto.subtle.importKey(
    "jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new AccessError("bad signature");

  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new AccessError("wrong audience");
  if (payload.iss !== teamDomain) throw new AccessError("wrong issuer");
  if (typeof payload.exp !== "number" || payload.exp < nowSec - 30) throw new AccessError("expired");
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + 30) throw new AccessError("not yet valid");
  if (!payload.email) throw new AccessError("no email in token");
  return payload;
}

export function resetCertCache() {
  certCache = { url: null, at: 0, keys: [] };
}
