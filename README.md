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
- **Live**: sessions still being recorded show a **Live** button in the list and the
  viewer. Live mode starts at the last DOM snapshot and follows the session about
  5 seconds behind the user (polls Loki every 3 s, plays with a 3 s buffer); the
  badge shows the current lag, **Exit live** returns to the full recording. Links
  open live with `?live=1`.
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

**Search fields** (optional): Faro event attributes a search looks up exactly in
every session's events, on the server, e.g. `lead_id` and `crm_lead_id` (the
dialer's `call.bridged` events). A value then finds every session with an event
carrying it, also those the list's 5000-marker limit leaves out; the replay
marks those events and opens at the first one. The sessions page keeps search,
apps and range in the URL (`?q=&apps=&lookback=`), so a link can open a search.
Without search fields the list is searched as before, in the browser.

**Call audio** (optional): the call recorder's read API URL (one for every
dialer environment, e.g. `http://call-recorder.call-recorder.svc:8081`) and its
read token (kept encrypted). The `recorder` plugin route (GET only, Editor)
adds the token on Grafana's side. A session plays the audio its own
`recording` v1 events point to:

| Row              | What it is                                                      |
| ---------------- | --------------------------------------------------------------- |
| Agent mic        | the agent's microphone, recorded on their computer, whole shift |
| Customer         | what the carrier sent the agent                                 |
| Agent at carrier | the agent as the carrier received them                          |
| Heard by agent   | what the agent's computer played                                |

Agent mic and Customer play by default: the conversation. Red marks audio lost
on the way (the agent's words missing at the carrier: their uplink; the
customer missing on their computer: their downlink); hatched, where the agent's
browser had no network; grey, where the carrier sent nothing. The audio follows
the replay's clock (play, pause, seek, skipped inactivity, 0.5–2x; muted
faster). Sessions without recording events, as every other app's, request
nothing from the recorder. Self-hosted Grafana only: the recorder is
cluster-internal.

## Install

Signed releases are privately signed for `https://grafana.ajaska.de/` and
`https://internalajaska.grafana.net/`; releases built without the signing secret
are unsigned (the release notes say which). For kube-prometheus-stack:

```yaml
grafana:
  grafana.ini:
    server:
      root_url: https://grafana.ajaska.de/ # must match the signature
    plugins:
      allow_loading_unsigned_plugins: ajaska-sessionreplay-app # only for unsigned releases
  plugins:
    # Grafana >= 12 preinstall format: id@version@url
    - ajaska-sessionreplay-app@0.1.0@https://github.com/ajaska-gmbh/grafana-sessionreplay-app/releases/download/v0.1.0/ajaska-sessionreplay-app-0.1.0.zip
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
