// Tests for tools/verify_live.mjs (the deploy job's "does the live Worker report this commit" check),
// against a real local HTTP server so redirects and headers behave like the real thing.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { verifyLive } from "../../tools/verify_live.mjs";

const SHA = "a".repeat(40);
const OLD = "b".repeat(40);

/** A server whose /version answer is whatever `answer(callNumber)` returns: [status, headers]. */
async function withServer(answer, fn) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/version");
    const [status, headers = {}] = answer(++calls);
    res.writeHead(status, headers);
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, () => calls);
  } finally {
    server.close();
  }
}
const fast = { delayMs: 0, sleep: async () => {} };

test("passes when the live Worker reports the expected commit", async () => {
  await withServer(() => [200, { "x-deploy-commit": SHA }], async (url) => {
    const r = await verifyLive({ url, expected: SHA, ...fast });
    assert.equal(r.ok, true);
    assert.match(r.message, new RegExp(SHA));
  });
});

test("waits for a new version to arrive: old commit first, then the new one", async () => {
  await withServer((n) => [200, { "x-deploy-commit": n < 4 ? OLD : SHA }], async (url, calls) => {
    const r = await verifyLive({ url, expected: SHA, ...fast });
    assert.equal(r.ok, true);
    assert.equal(calls(), 4);
  });
});

test("fails when the live Worker keeps reporting another commit (deploy did not go live)", async () => {
  await withServer(() => [200, { "x-deploy-commit": OLD }], async (url, calls) => {
    const r = await verifyLive({ url, expected: SHA, attempts: 5, ...fast });
    assert.equal(r.ok, false);
    assert.equal(calls(), 5);
    assert.match(r.message, /does not report commit a{40} after 5 tries/);
    assert.match(r.message, new RegExp(OLD));
  });
});

test("fails when the Worker reports no commit at all (old Worker)", async () => {
  await withServer(() => [403, {}], async (url) => {
    const r = await verifyLive({ url, expected: SHA, attempts: 2, ...fast });
    assert.equal(r.ok, false);
    assert.match(r.message, /HTTP 403, commit none/);
  });
});

test("an Access login redirect fails at once with the fix, without retrying", async () => {
  await withServer(() => [302, { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/x?kid=1" }], async (url, calls) => {
    const r = await verifyLive({ url, expected: SHA, ...fast });
    assert.equal(r.ok, false);
    assert.equal(calls(), 1);
    assert.match(r.message, /Bypass rule for the path \/version/);
  });
});

test("a redirect elsewhere is not mistaken for Access", async () => {
  await withServer(() => [301, { location: "https://example.com/elsewhere" }], async (url) => {
    const r = await verifyLive({ url, expected: SHA, attempts: 2, ...fast });
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.message, /Access/);
  });
});

test("without an expected commit it only checks that /version is reachable without a login", async () => {
  await withServer(() => [403, {}], async (url) => {
    const r = await verifyLive({ url, ...fast });
    assert.equal(r.ok, true);
    assert.match(r.message, /reachable without a login/);
    assert.match(r.message, /none \(older Worker\)/);
  });
  await withServer(() => [302, { location: "https://team.cloudflareaccess.com/login" }], async (url) => {
    assert.equal((await verifyLive({ url, ...fast })).ok, false);
  });
  await withServer(() => [200, { "x-deploy-commit": SHA }], async (url) => {
    assert.match((await verifyLive({ url, ...fast })).message, new RegExp(SHA));
  });
});

test("a Worker that cannot be reached fails after the tries and says why", async () => {
  const r = await verifyLive({ url: "http://127.0.0.1:1", expected: SHA, attempts: 2, ...fast });
  assert.equal(r.ok, false);
  assert.match(r.message, /no answer/);
});
