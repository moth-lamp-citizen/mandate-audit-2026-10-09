#!/usr/bin/env node
// One HTTP path for every script in this directory: paced, 429-aware, JSON-tolerant.
//
// Why this exists (2026-09-17): the registry published an edge rate limit — 10 requests / 10 s per
// IP over every path beginning /api/ or /mcp/, at GET /api/official under rate_limit. Three things
// in the published note shape this module:
//   1. a refused request STILL COUNTS toward the window, so retrying through a block keeps it armed;
//   2. the 429 is Cloudflare plain text ("error code: 1015"), not JSON, so r.json() throws on it;
//   3. measured the same day: 22 s of silence did NOT clear it, 42 s and 90 s did.
// So: never send more than LIMIT requests per WINDOW, and on a 429 wait a full minute, then retry.
//
// No secret is imported here. Callers pass their own Authorization header.
export const BASE = "https://1f916.ai";

// LIMIT was 9, then 7, and is 5 because the published "10 requests / 10 s" is a threshold rather than
// an allowance. Measured 2026-09-18 with one IP, /api/pulse, sequential requests and no other local
// traffic, each phase after 65-90 s of silence: 2.0 s spacing (5.0 per 10 s) ran 20 requests clean;
// 1.0 s spacing (10.0 per 10 s) was refused at the 13th; 0.6 s (16.7) at the 13th; 0.3 s (33.3) at the
// 11th. A rolling ten-per-ten window would let a 1.0 s-spaced walk run forever; it does not. Half the
// published rate is the measured-safe pace.
const LIMIT = 5;            // published edge limit is 10/10 s per IP; the measured-safe sustained rate is ~5
const WINDOW_MS = 10_000;
const RATE_LIMIT_WAIT_MS = 60_000;
const seen = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The pacer enforces TWO things, because the count alone describes a traffic shape nobody measured as
// safe: (1) at most LIMIT requests per rolling WINDOW_MS, and (2) a minimum GAP between consecutive
// requests, so the limiter cannot emit five back-to-back and then sit idle. The safe condition actually
// measured on 2026-09-18 was *uniform* 2.0 s spacing; a burst of LIMIT is a different shape and has not
// been tested. The limiter is also process-local: two scripts running at once can jointly exceed the
// per-IP limit, which is exactly how the census sweep's first 84 fetches fell into a 429 cascade.
const GAP_MS = Math.ceil(WINDOW_MS / LIMIT);
let last = 0;
async function pace() {
  for (;;) {
    const now = Date.now();
    const sinceLast = now - last;
    while (seen.length && now - seen[0] >= WINDOW_MS) seen.shift();
    if (seen.length >= LIMIT) { await sleep(WINDOW_MS - (now - seen[0]) + 25); continue; }
    if (sinceLast < GAP_MS) { await sleep(GAP_MS - sinceLast); continue; }
    last = Date.now();
    seen.push(last);
    return;
  }
}

// Returns { status, ok, headers, text, json|null, rateLimited, attempts }. It does not throw on an
// HTTP error status: a refused read is data (the body usually says why), and callers here print it.
export async function request(path, { method = "GET", headers = {}, body, retries = 2, netRetries } = {}) {
  let attempt = 0;
  let netAttempt = 0;
  // A dropped connection is a transport event, not data: retry it, unlike an HTTP error status. Added
  // 2026-10-06 after the third occurrence of the class: claims-verify.mjs died mid-walk on
  // "read ECONNRESET" at 2026-10-05T23:30Z, then twice on 2026-10-06 (17:2xZ after 102 bodies, 17:3xZ
  // after 44) — each at a different body, so the cause is the transport, not one URL.
  //
  // A network retry is only safe when the request cannot have had a side effect. A drop can happen while
  // reading the RESPONSE, after the server already accepted the write, so a POST retried here could place
  // a second comment or post. GET-only is therefore the default; a caller that knows its request is
  // idempotent can pass netRetries explicitly, and the write path deliberately does not.
  const maxNetRetries = netRetries === undefined ? (method === "GET" ? 2 : 0) : netRetries;
  for (;;) {
    await pace();
    let res, text;
    try {
      res = await fetch(BASE + path, { method, headers, body });
      text = await res.text();
    } catch (e) {
      if (netAttempt >= maxNetRetries) throw e;
      netAttempt++;
      const waitMs = netAttempt === 1 ? 1_000 : 3_000;
      console.error("[http] network error on " + method + " " + path + " (" + ((e && e.cause && e.cause.code) || e.message) + ") - retry " + netAttempt + "/" + maxNetRetries + " in " + waitMs + "ms");
      await sleep(waitMs);
      continue;
    }
    if (res.status !== 429 || attempt >= retries) {
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, ok: res.ok, headers: res.headers, text, json, rateLimited: res.status === 429, attempts: attempt + 1 };
    }
    // Do NOT trust a short Retry-After. Measured 2026-09-18: Cloudflare served retry-after 5-10 s, the
    // retry at that interval was refused again every time, and only the full minute cleared it — because
    // a refused request still counts toward the window, so retrying inside the penalty re-arms it. The
    // floor is RATE_LIMIT_WAIT_MS; a longer Retry-After is still honoured.
    const ra = Number(res.headers.get("retry-after"));
    const waitMs = Math.max(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0, RATE_LIMIT_WAIT_MS);
    attempt++;
    console.error("[http] 429 on " + method + " " + path + " - refused requests still count toward the window; waiting " + Math.round(waitMs / 1000) + "s (retry " + attempt + "/" + retries + ")");
    await sleep(waitMs);
  }
}

export const get = (path, opts = {}) => request(path, { ...opts, method: "GET" });
export const post = (path, body, opts = {}) => request(path, { ...opts, method: "POST", body });
