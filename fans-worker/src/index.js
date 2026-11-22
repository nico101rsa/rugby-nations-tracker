// rugby-tracker-fans: the small things fans make together. Two of them, each
// with its rules in its own file (read those first):
//   /pulse    how each side's fans feel, during a game and after it (pulse.js)
//   /online   how many phones had the app open in the last hour (online.js)
//
// WHY ITS OWN WORKER. The cron Worker next door (worker/) is the match-day
// scheduler: if it breaks, live scores go stale. Nothing a fan can send here
// may be able to do that, so this is a separate script with a separate
// deploy. A bad day here costs three faces under a result card and a count
// beside "Updated".
//
// WHY A DURABLE OBJECT. One object, one SQLite file, single-threaded: a vote
// and the count that follows it can't interleave, and there is nothing to
// provision: the class and its storage are declared in wrangler.jsonc and
// created by the deploy. A match weekend is a few thousand votes; one object
// takes that without noticing.

import { DurableObject } from "cloudflare:workers";
import { init, handle, makeLimiter, makeTally } from "./pulse.js";
import * as online from "./online.js";

// Which file answers a path. /health is the pulse's: it proves storage works.
const ROUTES = { "/pulse": "pulse", "/health": "pulse", "/online": "online" };

// The app is a WKWebView on capacitor://localhost, and the dev app runs on
// localhost: there is no single origin to name, and nothing here is behind a
// cookie or a credential, so any origin may read and vote.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra },
  });

export class PulseStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = (query, ...params) => ctx.storage.sql.exec(query, ...params).toArray();
    this.allow = makeLimiter();
    this.tally = makeTally();
    this.online = { allow: makeLimiter(online.PING_RATE), count: online.makeCounter(), purgeDue: online.makeEvery() };
    init(this.sql);
    online.init(this.sql);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? (await request.text()).slice(0, 2000) : "";
    // The address is used for the in-memory rate limits and never stored.
    const req = { method: request.method, path: url.pathname, body, ip: request.headers.get("cf-connecting-ip") ?? "", now: Date.now() };
    const { status, body: out } = ROUTES[url.pathname] === "online"
      ? online.handle(req, this.sql, this.online)
      : handle(req, this.sql, this.allow, this.tally);
    // A count may be a few seconds old; a vote's or a ping's own answer is never cached.
    const cache = request.method === "GET" && status === 200 && url.pathname !== "/health" ? { "cache-control": "public, max-age=15" } : { "cache-control": "no-store" };
    return json(status, out, cache);
  }
}

// A count this Worker was given in the last few seconds is handed to the next
// phone that asks, so most reads never reach the object at all. The object
// has a daily allowance on the free plan and it ran out mid round 6 (Sun 22
// Nov 2026, Sydney), with every phone on Results asking once a minute. Held
// in this isolate's memory; a vote's or a ping's own answer is never reused.
export const READ_TTL_MS = 15_000;

export function makeReadCache(ttlMs = READ_TTL_MS) {
  const kept = new Map();
  return {
    get(path, now = Date.now()) {
      const hit = kept.get(path);
      return hit && now - hit.at < ttlMs && now >= hit.at ? hit.text : null;
    },
    put(path, text, now = Date.now()) {
      kept.set(path, { at: now, text });
    },
  };
}

const reads = makeReadCache();
const CACHED = new Set(["/pulse", "/online"]);
const HIT_HEADERS = { "content-type": "application/json; charset=utf-8", ...CORS, "cache-control": "public, max-age=15" };

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const { pathname } = new URL(request.url);
    if (!ROUTES[pathname]) {
      return json(404, { error: "not found", what: "rugby-tracker fans worker: GET /pulse, POST /pulse, GET /online, POST /online, GET /health" });
    }
    const reading = request.method === "GET" && CACHED.has(pathname);
    if (reading) {
      const text = reads.get(pathname);
      if (text) return new Response(text, { status: 200, headers: HIT_HEADERS });
    }
    try {
      const store = env.PULSE.get(env.PULSE.idFromName("pulse-v1"));
      const res = await store.fetch(request);
      if (!reading || res.status !== 200) return res;
      const text = await res.text();
      reads.put(pathname, text);
      return new Response(text, { status: 200, headers: HIT_HEADERS });
    } catch (e) {
      console.error(`${ROUTES[pathname]} failed: ${e?.message ?? e}`);
      // The reason goes out with the refusal: it is Cloudflare's own sentence
      // (which allowance ran out, or what broke), nothing of a fan's, and on
      // 22 Nov 2026 nobody could say why the object was down because the
      // only copy was in a dashboard a cloud session can't open.
      return json(503, { error: "unavailable", reason: String(e?.message ?? e).slice(0, 300) }, { "cache-control": "no-store" });
    }
  },
};
