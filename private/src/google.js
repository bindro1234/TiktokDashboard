// Google Sheets v4 from a Worker: service-account OAuth with WebCrypto (no libraries).
// The key comes from the secret GOOGLE_SERVICE_ACCOUNT_B64 and only lives in memory.

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const BASE = "https://sheets.googleapis.com/v4/spreadsheets";
let tokenCache = { email: null, token: null, exp: 0 };

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (s) => b64url(new TextEncoder().encode(s));

export class SheetsError extends Error {}

function serviceAccount(b64) {
  if (!b64) throw new SheetsError("GOOGLE_SERVICE_ACCOUNT_B64 is not set");
  const bin = atob(b64.trim());
  const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  return JSON.parse(json);
}

async function accessToken(b64, fetchImpl) {
  const sa = serviceAccount(b64);
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.email === sa.client_email && tokenCache.exp - 120 > now) return tokenCache.token;
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const unsigned = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64urlText(JSON.stringify({
    iss: sa.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }),
  });
  if (!res.ok) throw new SheetsError(`Google login failed: HTTP ${res.status}`);
  const data = await res.json();
  tokenCache = { email: sa.client_email, token: data.access_token, exp: now + (data.expires_in || 3600) };
  return tokenCache.token;
}

const a1 = (tab, cells = "") => `'${tab.replace(/'/g, "''")}'` + (cells ? `!${cells}` : "");

export class Sheets {
  constructor(b64, fetchImpl = fetch) {
    this.b64 = b64;
    this.fetch = fetchImpl;
  }

  async call(id, method, path, { params, body } = {}) {
    const token = await accessToken(this.b64, this.fetch);
    const url = new URL(`${BASE}/${id}${path}`);
    for (const [k, v] of Object.entries(params || {})) {
      for (const item of [].concat(v)) url.searchParams.append(k, item);
    }
    const res = await this.fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new SheetsError(`Sheets ${method} ${path || "/"}: HTTP ${res.status}`);
    return res.status === 204 ? {} : res.json();
  }

  /** { tab: [[...header], [...row], ...] } for existing tabs; missing tabs come back as []. */
  async readTabs(id, tabs) {
    const meta = await this.call(id, "GET", "", { params: { fields: "sheets.properties.title" } });
    const existing = new Set((meta.sheets || []).map((s) => s.properties.title));
    const wanted = tabs.filter((t) => existing.has(t));
    const out = Object.fromEntries(tabs.map((t) => [t, []]));
    if (!wanted.length) return out;
    const data = await this.call(id, "GET", "/values:batchGet", {
      params: { ranges: wanted.map((t) => a1(t)), valueRenderOption: "UNFORMATTED_VALUE" },
    });
    (data.valueRanges || []).forEach((vr, i) => { out[wanted[i]] = vr.values || []; });
    return out;
  }

  async readRange(id, tab, cells) {
    const data = await this.call(id, "GET", `/values/${encodeURIComponent(a1(tab, cells))}`, {
      params: { valueRenderOption: "UNFORMATTED_VALUE" },
    });
    return data.values || [];
  }

  async append(id, tab, rows) {
    return this.call(id, "POST", `/values/${encodeURIComponent(a1(tab, "A1"))}:append`, {
      params: { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" }, body: { values: rows },
    });
  }

  async update(id, tab, cells, rows) {
    return this.call(id, "PUT", `/values/${encodeURIComponent(a1(tab, cells))}`, {
      params: { valueInputOption: "RAW" }, body: { values: rows },
    });
  }

  /** Create a tab with a header row if it does not exist yet. */
  async ensureTab(id, tab, header) {
    const meta = await this.call(id, "GET", "", { params: { fields: "sheets.properties.title" } });
    if ((meta.sheets || []).some((s) => s.properties.title === tab)) return;
    await this.call(id, "POST", ":batchUpdate", { body: { requests: [
      { addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } } },
    ] } });
    await this.update(id, tab, "A1", [header]);
  }
}

export function resetTokenCache() {
  tokenCache = { email: null, token: null, exp: 0 };
}
