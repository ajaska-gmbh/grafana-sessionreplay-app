# Session Replay

Browse and replay browser sessions recorded by Grafana Faro's `ReplayInstrumentation`
and stored in your own Loki.

- **Sessions**: recorded sessions with user, app, environment, browser, page loads and
  errors. Search, filter and sort them.
- **Replay viewer**: play/pause, skip ±10 s, timeline with error and navigation markers,
  speed, skip inactivity, share a link to the current moment, and fullscreen.
- **User Journey**: navigations, custom events, web vitals, logs, errors and network
  requests next to the player. You can jump to an event, open its details and trace,
  and follow playback.

Configure the Loki and Tempo datasources on the plugin's configuration page. See the
repository README for the required Alloy pipeline.
