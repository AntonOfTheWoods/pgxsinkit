---
name: operating
description: >-
  Load when deploying or operating a live pgxsinkit app, or when diagnosing a sync/write that "feels
  slow" in a browser even though the server is fast. Covers the runtime and deployment properties around
  the toolkit (not toolkit bugs) that decide whether a live app feels fast: convergence cadence (writes
  flush on enqueue; the interval is only a fallback), serverless edge cold starts and warming, forcing
  cache-control:no-store on a same-origin Electric shape proxy, the browser HTTP/2 connection budget when
  many shapes are synced, setting the edge worker timeout above Electric's long-poll, and the built-in
  globalThis.__pgxsinkitDebug latency instrumentation. Load before shipping to production or when writes
  take seconds to appear in another client.
metadata:
  type: task
  library: "@pgxsinkit/client"
  library_version: "0.1.32"
  source: https://pgxsinkit.github.io/start/operating-in-production/
---

# Operating a pgxsinkit app in production

The read/write/converge primitives are fast. When a live app feels slow it is almost always one of the
properties below — none are toolkit bugs; they are how serverless edges, browser HTTP, and CDN-shaped
caching behave. If writes or sync feel slow in a real browser but server benchmarks are fast, start here.

## Convergence cadence: event-driven, interval is a fallback

When you pass an `autoSync` trigger to `createSyncClient`, the client drives `flush → reconcile`. The
pass is **event-driven**: the client calls `requestPass()` the moment a mutation is enqueued, so a local
write flushes to the server immediately — it does **not** wait for the interval. The interval
(`createBrowserConvergenceTrigger({ intervalMs })`, default 1.5s) is only a fallback for
retries/recovery/cross-tab.

Therefore **keep the interval long.** A short interval is the dominant idle cost: every PGlite query is
~50ms of WASM work on one thread, and an unconditional reconcile each tick re-runs every live query. The
demo uses `intervalMs: 15_000`, cutting idle CPU from ~70% of a core to ~2% with **no change to
convergence latency** (latency is bounded by the Electric echo, not the interval). Do **not** shorten
the interval to "make writes faster" — it does nothing and burns CPU.

## Serve the gateway over HTTP/2 (the connection budget)

Electric's client holds **one live long-poll connection open per synced shape**. A client subscribing to
six shapes keeps six connections busy, and browsers cap **HTTP/1.1 at ~6 connections per origin** — so
over plain HTTP those long-polls consume every slot and the **write** request (same origin) is
**Stalled in the browser's connection queue** for a whole long-poll cycle before it is even dispatched.
This presents as multi-second writes that are invisible to `curl`/Node (which have no per-host cap) —
only a real browser shows it (DevTools → Network → a stuck `write` with a long **Stalled** time).

Fix: serve the gateway over **HTTP/2** (or HTTP/3), which multiplexes every request over one connection.
Any production ingress already does (Cloud Supabase, Electric Cloud, istio/Envoy, a TLS reverse proxy);
it only bites a local stack on plain `http://` (browsers only negotiate HTTP/2 over TLS).

## Serverless edge cold starts

On a serverless edge a worker is suspended when idle and evicted after longer idle, so the **first write
after a quiet period** pays a cold start while steady-state writes are instant (measured: ~20ms warm,
~0.45s after ~15s idle, ~5.8s on a cold module cache). This is a property of the deployment target, not
pgxsinkit — a long-lived Bun/Deno process or a managed warm pool has none. Mitigate: keep the worker warm
with a periodic cheap request (an empty `{"mutations":[]}` POST, rejected at validation before any DB
work), and set the worker wall-clock timeout **above** Electric's ~25s long-poll so a live subscription
is not recycled mid-cycle.

## Proxying Electric: force `cache-control: no-store`

Electric tags shape responses with a CDN-oriented `cache-control` (`max-age`, `stale-while-revalidate`).
Behind a **same-origin proxy with no CDN**, the browser cache serves them **stale** the moment a shape
handle rotates (re-seed, re-login, restart), and the client loops on "expired shape handle" **409s**
until it self-heals. Force `cache-control: no-store` on the proxied response:

```ts
const response = await proxyElectricShapeRequest(request, claims, { registry, electricUrl });
const headers = new Headers(response.headers);
headers.set("cache-control", "no-store");
return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
```

Resumption stays cheap because Electric's offset/handle bookkeeping (in the local store) makes it cheap,
not the HTTP cache.

## Debugging latency: `globalThis.__pgxsinkitDebug`

`@pgxsinkit/client` ships opt-in, off-by-default, timestamped instrumentation that traces a write through
every phase. Enable it from the console or before boot:

```js
globalThis.__pgxsinkitDebug = true; // reproduce, then filter the console to "pgxsinkit" + enable Verbose
```

Read the **gaps** between phases: `convergence pass requested` → `flush` / `reconcile` (durations);
`board-write auth token resolved {ms}` (a stalling per-request token fetch shows here);
`board-write responded {status, ms}` (a cold worker, or a browser connection stall, shows here);
`sync received change batch` → `sync applied {ms}`; `live query updated → re-render`.

**Measure at the network boundary, not by polling PGlite.** Each PGlite query is ~50ms on one thread, so
a tight `setInterval` reading PGlite to "watch" a value inflates the very latency it reports. Trust the
instrumentation's network timings and a server-side `curl` over a poll loop.

## Common mistakes

- Shortening the convergence interval to chase write latency (no effect; wastes CPU).
- Serving many-shape sync over plain HTTP/1.1 and blaming the server for stalled writes.
- Omitting `cache-control: no-store` on a same-origin shape proxy → intermittent 409 loops.
- Treating an edge cold start as a toolkit/sync-rail problem.
- Measuring latency by polling PGlite in a loop instead of at the network boundary.

Full prose: <https://pgxsinkit.github.io/start/operating-in-production/>.
