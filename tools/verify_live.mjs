// Checks the live private Worker: does /version answer without a login, and does it report the commit we expect?
//
//   node tools/verify_live.mjs <worker url> [expected commit]
//
// With an expected commit (the deploy job passes the one it just deployed) it exits 1 unless the live Worker
// reports exactly that commit, retrying for a while because a new version takes a moment to reach every
// Cloudflare location. Without one it only checks that /version is reachable without a login (use it to test
// the Access rule before merging; an older Worker answers there too, just without a commit).
//
// Needs no secrets: /version is the one path Access lets through (README, "Versiecontrole").

const HEADER = "x-deploy-commit";

/** One request, classified. Never throws: a network error is a result too. */
export async function probe(url, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(new URL("/version", url), { redirect: "manual", headers: { "cache-control": "no-cache" } });
  } catch (err) {
    return { kind: "network", detail: String(err?.cause?.code || err?.message || err) };
  }
  const location = res.headers.get("location") || "";
  if (res.status >= 300 && res.status < 400 && /cloudflareaccess\.com/i.test(location)) {
    return { kind: "access", status: res.status };
  }
  return { kind: "worker", status: res.status, commit: res.headers.get(HEADER) || null };
}

/**
 * @returns {{ok: boolean, message: string}}
 */
export async function verifyLive({
  url, expected = "", fetchImpl = fetch, attempts = 12, delayMs = 10000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    last = await probe(url, fetchImpl);
    if (last.kind === "access") {
      // Deterministic: waiting won't help. Access has no Bypass rule for /version yet.
      return {
        ok: false,
        message: "Cloudflare Access stops the request to /version (redirect to the login). Add the Bypass rule for the "
          + "path /version once (README, 'Versiecontrole'); the deploy itself is fine.",
      };
    }
    if (last.kind === "worker") {
      if (!expected) {
        return { ok: last.status < 500, message: `/version is reachable without a login (HTTP ${last.status}), `
          + `reports commit ${last.commit || "none (older Worker)"}.` };
      }
      if (last.commit === expected) return { ok: true, message: `live Worker reports commit ${expected}` };
    }
    if (i < attempts) await sleep(delayMs);
  }
  const seen = last.kind === "worker"
    ? `HTTP ${last.status}, commit ${last.commit || "none"}`
    : `no answer (${last.detail})`;
  return { ok: false, message: `live Worker does not report commit ${expected || "(any)"} after ${attempts} tries: ${seen}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [url, expected = ""] = process.argv.slice(2);
  if (!/^(https:\/\/|http:\/\/127\.0\.0\.1[:/])/.test(url || "")) { // plain http only for local tests
    console.error("usage: node tools/verify_live.mjs <https://worker url> [expected commit]");
    process.exit(2);
  }
  const { ok, message } = await verifyLive({ url, expected });
  console.log(ok ? `OK: ${message}` : `::error::${message}`);
  process.exit(ok ? 0 : 1);
}
