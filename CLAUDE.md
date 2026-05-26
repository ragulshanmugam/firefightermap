# FirefighterMap — Agent Notes

## Critical correctness invariants

- **Fire IDs must be stable across scans.** `fireId(kind, subjects, firstSeenMs)` in `src/server/core/detector.ts` derives a deterministic id from the fire's semantic identity. The snooze flow (`/api/snooze` in `src/server/server.ts`) stores the id in `fmap:snoozed`; if the same logical fire gets a different id on the next 1-minute scan, the snooze silently breaks. Do NOT change the id to anything that varies with sort order, scan timestamp, or tick count.

- **`SlidingWindow.record` does NOT trim.** Trim runs once per minute from `FireDetector.tickBaseline` to keep ingest off the Redis-trim hot path. If you add a new bucket, make sure it's in the `bucketKeys` list passed to `tickBaseline` (or pass it explicitly), or it will grow forever.

- **In-memory baselines are not persisted.** `FireDetector.baselines` and `recentSigs` reset on cold start. The seed-demo menu (`/internal/menu/seed-demo`) uses `seedBaseline()` to pre-warm; production cold starts have no equivalent yet — this is a known gap.

## Dormant

- **`coordinated_reporters`** detector is implemented but unreachable: Devvit's `PostReport` / `CommentReport` triggers do not expose reporter identity, so `ingestReport` in `server.ts` cannot populate `reporter:*` buckets. The scanner runs but always returns `[]`. Leave the code as-is until Devvit exposes reporter ids.

## Devvit-specific gotchas

- Webview iframe blocks `window.open` and `target=_blank`. Use `navigateTo` from `@devvit/client` (already wired in `splash.ts:navAction`).
- Devvit redis exposes `zCard` and `zRange` but NOT `zCount` — `devvitKv.zCount` implements via `zRange().length`. Don't "optimize" it back to a native call; it doesn't exist.
- Client tsconfig excludes `src/server/**`, so the client can't import shared types from the server tree. `KIND_LABELS` is intentionally duplicated in `server.ts` and `splash.ts`; keep both in sync.
