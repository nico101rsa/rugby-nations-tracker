// rugby-tracker-fans: the small things fans make together. Today that is the
// full-time pulse (src/pulse.js has the rules; read that first).
//
// WHY ITS OWN WORKER. The cron Worker next door (worker/) is the match-day
// scheduler: if it breaks, live scores go stale. Nothing a fan can send here
// may be able to do that, so this is a separate script with a separate
// deploy. A bad day here costs three faces under a result card.
//
// WHY A DURABLE OBJECT. One object, one SQLite file, single-threaded: a vote
// and the count that follows it can't interleave, and there is nothing to
// provision: the class and its storage are declared in wrangler.jsonc and
// created by the deploy. A match weekend is a few thousand votes; one object
// takes that without noticing.

import { DurableObject } from "cloudflare:workers";
import { init, handle, makeLimiter } from "./pulse.js";

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
    init(this.sql);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? (await request.text()).slice(0, 2000) : "";
    const { status, body: out } = handle(
      // The address is used for the in-memory rate limit and never stored.
      { method: request.method, path: url.pathname, body, ip: request.headers.get("cf-connecting-ip") ?? "", now: Date.now() },
      this.sql,
      this.allow,
    );
    // A count may be a few seconds old; a vote's own answer is never cached.
    const cache = request.method === "GET" && status === 200 && url.pathname === "/pulse" ? { "cache-control": "public, max-age=15" } : { "cache-control": "no-store" };
    return json(status, out, cache);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const { pathname } = new URL(request.url);
    if (pathname !== "/pulse" && pathname !== "/health") {
      return json(404, { error: "not found", what: "rugby-tracker fans worker: GET /pulse, POST /pulse, GET /health" });
    }
    try {
      const store = env.PULSE.get(env.PULSE.idFromName("pulse-v1"));
      return await store.fetch(request);
    } catch (e) {
      console.error(`pulse failed: ${e?.message ?? e}`);
      return json(503, { error: "unavailable" }, { "cache-control": "no-store" });
    }
  },
};
