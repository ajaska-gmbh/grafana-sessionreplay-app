# Session Replay for self-hosted Grafana

A Grafana app plugin that plays back browser sessions recorded by Grafana Faro's
[`@grafana/faro-instrumentation-replay`](https://www.npmjs.com/package/@grafana/faro-instrumentation-replay)
and stored in **your own Loki**. It follows the user experience of Grafana Cloud's
Session Replay (`grafana-sessionreplay-app`), which only works with data sent to the
Grafana Cloud collector.

- **Sessions**: every recorded session in a time range. Filter by app and
  environment, search by session, user, page or browser, and sort by start, page
  loads or errors.
- **Replay viewer** at `/a/ajaska-sessionreplay-app/app/<app_name>/session/<session_id>?t=<ms>`
  (the same shape as Grafana Cloud's). Controls:
  - elapsed and total time, play/pause, skip ±10 s, timeline with error and
    navigation markers;
  - playback speed, skip inactivity, **Share** (copies a link to the current
    moment) and fullscreen;
  - a header with the title and URL of the page the user was on.
- **User Journey** beside the player:
  - a **Journey** tab (navigations, custom events, web vitals, logs, errors; filters
    _Navigation_ / _Custom_ / _Errors_) and a **Network** tab (`Fetch request (POST 200)`);
  - per event: offset, _Jump to this event_ and the details, with a link to the
    trace in Tempo;
  - **Follow playback** keeps the list in sync with the player.
- **Session-only links**: `/a/ajaska-sessionreplay-app/session/<session_id>` looks up the app
  and opens the viewer. Use it from a Loki derived field (`session_id=(\w+)`), so every
  Faro log line in Explore links to its replay.
- **Embeddable player**: other plugins can render
  `ajaska-sessionreplay-app/replay-player/v1` with `{ appName, sessionId, from?, to?, t?, height? }`.

## How it works

```text
Browser (Faro + ReplayInstrumentation)
  -> Alloy faro.receiver -> loki.process "faro" -> Loki
       {source="faro"}                            logs, events, errors, measurements
       {source="faro_replay", replay="marker"}    session recording started/paused/resumed
       {source="faro_replay", replay="payload"}   rrweb events (DOM snapshots, can be MBs)
       app_name / app_environment as structured metadata (not labels)
  -> this app (queries Loki through Grafana's /api/ds/query, so datasource access rules apply)
```

The streams are a fixed set, so a new frontend (or anything a public client
sends) never creates Loki streams or needs a config change. The app finds replays
and journeys by `session_id` and filters apps with `| app_name=~"…"`.

Playback uses `@grafana/rrweb`, the same rrweb fork the recorder uses. Keep it on the
version that `@grafana/faro-instrumentation-replay` depends on.

### Requirements

- Grafana ≥ 13.2.
- Loki 3 with structured metadata enabled (`allow_structured_metadata: true`) and
  `max_line_size` large enough for DOM snapshots (we use `8MB`), written to directly or
  through a gateway that accepts large bodies.
- Alloy ≥ 1.20 for `faro.receiver` when the Faro Web SDK is ≥ 2.13. The SDK sends an
  `Idempotency-Key` header, and older receivers reject the CORS preflight, which drops
  **all** Faro telemetry. Ideally run it as its own collector for browser traffic;
  ours is `alloy-faro` in `kubernetes-configs/monitoring-new/alloy-faro-values.yaml`.
- Alloy pipeline:

  ```alloy
  faro.receiver "default" {
    output { logs = [loki.process.faro.receiver] }
  }

  loki.process "faro" {
    forward_to = [loki.write.faro.receiver]

    stage.logfmt {
      mapping = { app_name = "", app_environment = "" }
    }
    stage.structured_metadata {
      values = { app_name = "", app_environment = "" }
    }
    stage.static_labels {
      values = { source = "faro" }
    }
    stage.match {
      selector = "{source=\"faro\"} |= \"event_name=faro.session_recording.event \""
      stage.static_labels {
        values = { source = "faro_replay", replay = "payload" }
      }
    }
    stage.match {
      selector = "{source=\"faro\"} |= \"event_name=faro.session_recording.\""
      stage.static_labels {
        values = { source = "faro_replay", replay = "marker" }
      }
    }
  }
  ```

  Alloy's default `logfmt` log format is expected.

### Configuration

_Administration → Plugins → Session Replay → Configuration_: choose the Loki
datasource (default uid `loki`) and the Tempo datasource used for trace links
(default uid `tempo`).

The pages are available to the **Editor** role and above. Recordings can contain
personal data, so restrict access the same way you restrict Explore on Loki.

## Install

Releases are privately signed for `https://grafana.ajaska.de/` and
`https://internalajaska.grafana.net/`. For kube-prometheus-stack:

```yaml
grafana:
  grafana.ini:
    server:
      root_url: https://grafana.ajaska.de/ # must match the signature
  plugins:
    - https://github.com/ajaska-gmbh/grafana-sessionreplay-app/releases/download/v0.1.0/ajaska-sessionreplay-app-0.1.0.zip;ajaska-sessionreplay-app
```

## Development

Node 24 (see `.nvmrc`).

```bash
npm ci
npm run dev        # build + watch
npm run test:ci    # unit tests
npm run typecheck && npm run lint
```

Local Grafana: `npm run server` starts Grafana via `docker-compose.yaml` with
`provisioning/`. That means a `Loki` datasource (uid `loki`) at
`http://host.docker.internal:3100` and the app enabled. Run Loki and Alloy with the
pipeline above, and point a page with Faro + `ReplayInstrumentation` at
`http://localhost:12347/collect`.

## Release

1. Bump `version` in `package.json` and push a matching tag (`v0.1.0`).
2. `.github/workflows/release.yml` builds and tests, signs with the repository secret
   `GRAFANA_ACCESS_POLICY_TOKEN` (Grafana Cloud access policy, scope `plugins:write`),
   and attaches `ajaska-sessionreplay-app-<version>.zip` to the GitHub release.

To sign for another Grafana URL, add it to `ROOT_URLS` in the release workflow.

## License

Apache-2.0
