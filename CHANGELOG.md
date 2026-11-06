# Changelog

## 0.5.2

- Call audio plays: the recorder route matches the paths under it (Grafana 13 matches plugin routes as patterns, so `recorder` alone answered "plugin route match not found" for every listing and file).

## 0.5.1

- Call audio where the agent's computer clock is wrong (it can be hours off): segments are filed on the server's clock with the offset they were corrected by, and placed back on the replay by it; the listing covers the session's measured offsets.
- Times of day shown and typed in the player are on the server's clock (the agent computer's measured offset), so they match the dialer's and the CRM's times.
- Live: audio recorded after the replay was opened is listed too.

## 0.5.0

- Search by lead: configurable search fields are looked up exactly in every session's events, server-side; search, apps and range in the URL; matches are badged, marked in the replay and jumped to.
- Call audio: what the agent's computer recorded (their microphone, whole shift, and what they heard) on the timeline, played in step with the replay, with where the microphone was not recorded and where the browser had no network.
- Long recordings: the player's time no longer re-renders React every frame; the User Journey renders only the rows in view; loaded pages are merged instead of re-sorted.

## 1.0.0 (Unreleased)

Initial release.
