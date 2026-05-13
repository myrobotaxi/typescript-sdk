# Observability

The SDK exposes a pluggable observability surface — Logger + MetricsRecorder
— so consumers wire their preferred backends without the SDK depending on any
vendor. The Next.js app at P7 wires the SDK to [`@vercel/analytics`](https://vercel.com/docs/analytics)
for browser KPIs and [`@vercel/otel`](https://vercel.com/docs/otel) for
server-side spans.

Three pieces ship together:

1. **`Logger`** — structured log emitter (`debug` / `info` / `warn` / `error`).
2. **`MetricsRecorder`** — counter / histogram / gauge primitives.
3. **`redactP1` + `RedactingLogger`** — the non-negotiable redaction layer that
   sits between SDK call sites and any consumer-supplied Logger.

All three are exported from the SDK root.

```ts
import {
  ConsoleLogger,
  InMemoryMetricsRecorder,
  Metric,
  RedactingLogger,
  redactP1,
} from '@myrobotaxi/sdk';
```

---

## Logger

```ts
interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
```

### Default — `ConsoleLogger`

Silent in production (`NODE_ENV === 'production'`), `debug`-level otherwise.
Browser-safe — uses `globalThis.process?.env?.NODE_ENV` defensively.

```ts
const logger = new ConsoleLogger();              // dev-default
const silent = new ConsoleLogger({ level: 'silent' });
const warn   = new ConsoleLogger({ level: 'warn' });
```

Levels (high → low): `silent` < `error` < `warn` < `info` < `debug`. Setting
`level: 'warn'` suppresses debug + info but still emits warn + error.

### Wiring your own

Any object with `debug`/`info`/`warn`/`error` methods works. The SDK auto-wraps
whatever you inject with `RedactingLogger` inside its client constructor, so
P1 data can never reach your sink.

Example Pino adapter:

```ts
import pino from 'pino';
import type { Logger } from '@myrobotaxi/sdk';

const pinoLogger = pino();
const sdkLogger: Logger = {
  debug: (m, meta) => pinoLogger.debug(meta, m),
  info:  (m, meta) => pinoLogger.info(meta, m),
  warn:  (m, meta) => pinoLogger.warn(meta, m),
  error: (m, meta) => pinoLogger.error(meta, m),
};
// pass `sdkLogger` to the SDK client (MYR-50 will define the constructor)
```

---

## P1 redaction (non-negotiable)

P1 data classification covers GPS coords, addresses, location names, license
plates, user PII (email/name/avatar), OAuth tokens, and drive route polylines
(see `myrobotaxi/telemetry/docs/contracts/data-classification.md` §1).

The SDK wraps every consumer-supplied Logger with `RedactingLogger`. Every
`meta` argument is structurally redacted before it reaches your Logger:

```ts
import { redactP1 } from '@myrobotaxi/sdk';

redactP1({
  vehicleId: 'clxyz...',
  latitude: 37.7749,
  destinationAddress: '500 Howard St',
});
// → { vehicleId: 'clxyz...', latitude: '[REDACTED]', destinationAddress: '[REDACTED]' }
```

### Containment rule

If any key under a container is P1, the entire container is redacted (not just
the offending key). This closes the leak where logging a "route point" (whose
keys `lat`/`lng` are P0 in isolation but in aggregate are P1 per §1.5) would
otherwise leak GPS via the parent shape:

```ts
redactP1({ routePoints: [{ lat: 37.7, lng: -122.4, ts: 1 }] });
// → { routePoints: '[REDACTED]' }
```

### VIN special case

VINs are P0-classified but per §2.1 must always be redacted to the last 4
characters in logs:

```ts
redactP1({ vin: '5YJ3E1EA7KF000123' });
// → { vin: '***0123' }
```

### Message strings are NOT redacted

`redactP1` only walks the `meta` object. The free-text `message` argument
passes through unchanged. **Do not embed P1 values in message strings** —
keep them in `meta` so the redaction layer can catch them:

```ts
// BAD: GPS leaks via the message
logger.info(`vehicle at ${latitude}, ${longitude}`, { vehicleId });

// GOOD: redaction sanitizes meta
logger.info('vehicle position update', { vehicleId, latitude, longitude });
```

### What's redacted vs preserved

| Always redacted to `[REDACTED]` | Reason |
|---|---|
| `latitude`, `longitude`, `lat`, `lng`, `destination{Latitude,Longitude}`, `origin{Latitude,Longitude}` | GPS coords |
| `locationName`, `locationAddress`, `destinationName`, `destinationAddress`, `startLocation`, `startAddress`, `endLocation`, `endAddress` | Reverse-geocoded location strings |
| `navRouteCoordinates`, `routePoints`, `routeCoordinates` | Drive polylines (whole container) |
| `licensePlate` | Vehicle PII |
| `email`, `userEmail`, `name`, `userName`, `image` | User PII |
| `token`, `accessToken`, `refreshToken`, `idToken` (camelCase + snake_case) | OAuth credentials |

| Always redacted differently | Format |
|---|---|
| `vin` | `***XXXX` (last 4 chars) |

| Preserved as-is | Reason |
|---|---|
| `vehicleId`, `driveId`, `userId`, `accountId`, `inviteId`, `id` | Opaque cuids; P0 |
| `status`, `chargeLevel`, `speed`, `heading`, … | Operational telemetry; P0 |

The catalog is keyed off the field names in
`data-classification.md` §1.1–§1.7. Updating that doc requires a paired update
to `packages/sdk/src/observability/redact.ts`.

---

## MetricsRecorder

```ts
interface MetricsRecorder {
  counter(name: string, tags?: Record<string, string>): void;
  histogram(name: string, value: number, tags?: Record<string, string>): void;
  gauge(name: string, value: number, tags?: Record<string, string>): void;
}
```

### Default — `InMemoryMetricsRecorder`

Bounded ring buffer per series, default capacity 1000 samples. Drain via
`getSnapshot()`, reset via `clear()`.

```ts
const metrics = new InMemoryMetricsRecorder({ capacity: 5000 });
metrics.counter(Metric.WS_RECONNECT);
metrics.histogram(Metric.WS_MESSAGE_LATENCY_MS, 42);
const snap = metrics.getSnapshot();
//   snap.counters[Metric.WS_RECONNECT]      → [ { value: 1, ts, tags? } ]
//   snap.histograms[Metric.WS_MESSAGE_LATENCY_MS] → [ { value: 42, ts, tags? } ]
```

### Tag policy

**Metric tags must be P0 only.** The SDK never passes P1 values (email, GPS,
address) as tags. Consumer-supplied tag values must follow the same rule.
This is a code-discipline rule, not a runtime check — the perf cost of
validating tags on every metric call doesn't justify the protection given
that the SDK's own emitters are reviewed for compliance.

### Metric catalog

| Constant | Name on the wire | Type | Tags | Emitted when |
|---|---|---|---|---|
| `Metric.WS_CONNECT_ATTEMPTS` | `ws_connect_attempts_total` | counter | `outcome=success\|fail\|timeout` | Every WS connect attempt |
| `Metric.WS_RECONNECT` | `ws_reconnect_total` | counter | — | Every reconnect cycle |
| `Metric.WS_MESSAGE_RECEIVED` | `ws_message_received_total` | counter | `type=vehicle_update\|drive_started\|drive_ended\|…` | Each frame parsed |
| `Metric.WS_MESSAGE_LATENCY_MS` | `ws_message_latency_ms` | histogram | — | server-emit timestamp → client-receive |
| `Metric.REST_REQUEST_DURATION_MS` | `rest_request_duration_ms` | histogram | `endpoint`, `status` | Each REST call |
| `Metric.DATA_STALENESS_EVENTS` | `data_staleness_events_total` | counter | `group=nav\|charge\|gps\|gear` | Stale-data signal from server |
| `Metric.AUTH_FAILED` | `auth_failed_total` | counter | `subCode=null\|reauth_required` | Auth failure |

Constants live in `packages/sdk/src/observability/metrics.ts`. Future ticket
implementations (MYR-50 WS client, MYR-80 REST client, MYR-51 reconciler)
reference these constants rather than string literals.

### Wiring your own

#### Server-side: `@vercel/otel`

```ts
import { metrics } from '@opentelemetry/api';
import type { MetricsRecorder } from '@myrobotaxi/sdk';

const meter = metrics.getMeter('myrobotaxi');
const counters = new Map<string, ReturnType<typeof meter.createCounter>>();
const histograms = new Map<string, ReturnType<typeof meter.createHistogram>>();

const otelRecorder: MetricsRecorder = {
  counter(name, tags) {
    let c = counters.get(name);
    if (!c) { c = meter.createCounter(name); counters.set(name, c); }
    c.add(1, tags);
  },
  histogram(name, value, tags) {
    let h = histograms.get(name);
    if (!h) { h = meter.createHistogram(name); histograms.set(name, h); }
    h.record(value, tags);
  },
  gauge(name, value, tags) {
    // OTel ObservableGauge requires a callback; use UpDownCounter for set-style gauges
    let g = counters.get(`gauge:${name}`);
    if (!g) { g = meter.createUpDownCounter(name); counters.set(`gauge:${name}`, g); }
    g.add(value, tags);
  },
};
```

#### Browser-side: `@vercel/analytics`

```ts
import { track } from '@vercel/analytics';
import type { MetricsRecorder } from '@myrobotaxi/sdk';

const analyticsRecorder: MetricsRecorder = {
  counter(name, tags) { track(name, { ...tags }); },
  histogram(name, value, tags) { track(name, { value, ...tags }); },
  gauge(name, value, tags) { track(name, { value, ...tags }); },
};
```

(Vercel Analytics conflates the three primitives; if you need true histograms
in the browser, batch them yourself and ship via your own OTel-shaped
endpoint.)

---

## Bundle-size impact

The observability layer adds approximately 2–3 KB minified+gzipped to the
core bundle. That's well within the 75 KB total budget (NFR-3.30). MYR-54
will land the CI gate that enforces the budget.

## Roadmap notes

- A `Tracer` interface (OTel-shaped) is **not** in this PR. If/when SDK call
  sites need explicit span management beyond what counter/histogram covers,
  file a follow-up. The Next.js consumer's `@vercel/otel` integration can
  carry spans without an SDK-side abstraction in the meantime.
- Async / push-based metric drainage is **not** in this PR. The current
  `getSnapshot()` returns a frozen view that consumers drain on their own
  schedule. If a consumer needs push semantics, wrap `InMemoryMetricsRecorder`
  with their own adapter.
- A dev-only `validateMetricTags()` decorator that warns when SDK call sites
  emit P1-looking tag values is a candidate follow-up — currently the code
  discipline is enforced by review.
