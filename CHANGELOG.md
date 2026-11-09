# Changelog

## 0.6.0

- Replays load progressively: the session's index (page loads and 5-minute checkouts) comes first, so the full timeline, tabs, journey markers, audio levels and call audio show at once, whatever the length. The replay then loads chunk by chunk (one checkout of one recording), four at a time, starting where playback starts — the link's `t`, the search match or a seek — and goes on in the background outward from the playhead. Seeking re-prioritises and cancels requests no longer needed; unloaded parts are hatched on the timeline, and playback waits with "Loading…" where it reaches one. Length, seek range and play-from-end come from the index; share links, search seek, journey markers and audio keep their offsets.
- A checkout whose Meta line was lost is still played (after the checkout before it); chunks that failed after retries say so and are tried again on the next seek there.
- Live mode starts right after the index (not after the whole session loaded), with the newest checkout first, and picks up new checkouts, reloads and tabs.
- Every Loki request carries its own request id and is cancelled when the viewer leaves, the session or the tab changes.
- Sessions list: the app filter also runs as a line filter before `| logfmt` (active sessions, error counts, search), so other apps' lines are not parsed and lines without the app in structured metadata (> 64 KiB) still count.

## 0.5.3

- Long replays load much faster: sessions recorded after the Alloy pipeline labels the payload stream by session bucket (`session_bucket`, adler32(session_id) % 256) read only their own bucket, about 1/256 of all sessions' payload, instead of all of it. Configured by `payloadBuckets` / `payloadBucketsSince` (provisioned with the pipeline); older sessions, and a bucket without the session, read the whole stream as before.

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
