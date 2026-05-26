# FirefighterMap

**Real-time statistical mod intelligence for subreddits.** Surfaces coordinated abuse — bursts, near-duplicate spam waves, coordinated reporters, target brigading — before a human can scroll the modqueue.

Submission for the **Reddit Mod Tools & Migrated Apps** hackathon (Devvit Web).

---

## The problem

Modqueues are linear. A mod sees 200 items one at a time. They can't see that 8 of those 200 are the same spam from 8 fresh accounts, or that one user just spiked 10× their baseline activity, or that two accounts are flagging the same set of posts in a coordinated wave.

Pattern-matching is the bottleneck. The signal exists; the surface doesn't.

## The solution

FirefighterMap runs four statistical detectors continuously against the post / comment / report stream of a subreddit. When a pattern crosses threshold, it surfaces as a **fire** on a live dashboard. One click sends structured evidence to the mod team's inbox.

**Four detectors, all running every minute:**

| Detector | What it catches | Method |
|---|---|---|
| **User burst** | One user posting 10× their baseline | Adaptive z-score over Welford rolling stats, per-user |
| **Near-duplicate wave** | Same spam reposted across distinct accounts | MinHash (FNV-1a, K=64) + Jaccard similarity ≥ 0.7 |
| **Coordinated reporters** | Two accounts flagging the same set of items | Jaccard over reported-target sets per reporter pair |
| **Target report burst** | One post brigaded with reports | z-score on report rate per target |

**Four mod actions per fire**, no automated removal:

- Open the sub's modqueue (via Devvit's host bridge)
- Open the offending user's profile
- Send structured evidence to mod team via **Mod Discussions**
- Snooze the fire for 15 minutes (Redis TTL-backed)

## What makes it novel

We did the competitive research. Nothing in the Reddit / Devvit ecosystem combines all four signals on one transparent dashboard:

- **AutoModerator** — rule-based regex/keyword, zero statistics, zero cluster awareness
- **r/toolbox** — per-item workflow tooling, no anomaly detection
- **ContextMod** — closest competitor; does single-author near-dup with Dice + Cosine + Levenshtein. **Per-author only, not cross-account.** No dashboard.
- **fsvreddit's Devvit apps** (spam-src-spotter, evasion-guard, hive-protect, bot-bouncer) — single-signal threshold-based, no clustering, no unified surface
- **Sift / Spectrum Labs / Hive** — full coordinated-abuse detection but enterprise-only, locked behind sales quotes
- **Discord Wick** — closest analog in any community-scale ecosystem; raid detection via join-rate, not content similarity

The wedge: **Welford + MinHash + report-graph in one real-time view. No LLM. Runs on Devvit primitives.**

Statistical, not classifier-based. Every fire shows you the z-score and the observed-vs-baseline counts. **Transparent and explainable** — the opposite of Reddit's black-box harassment filter. Mods can tune sensitivity per subreddit.

## How it works

```
                Devvit Triggers                        Cron (1 min)
                ───────────────                        ────────────
                                                            │
  post-submit ┐                                             ▼
  comment-submit ─→ HTTP server ──→ FireDetector.scan()
  post-report ┘             │                          │
  comment-report            ▼                          ▼
                    Redis sliding window      Welford baselines (in-memory)
                    (per-bucket zset)         MinHash signatures
                                                       │
                                                       ▼
                                          Redis: fmap:fires (JSON)
                                                       │
                                                       ▼
                                       /api/fires ─→ Dashboard (webview)
                                                       │
                                                       ▼
                              Mod actions via @devvit/client navigateTo
                              + reddit.modMail.createModNotification
```

**No LLM, no external API, no token cost.** Detection is pure statistics: rolling Welford on per-bucket counts, adaptive z-score with a min-count floor, MinHash over text shingles for near-dup, Jaccard over reporter-target sets for coordinated detection. State lives in Devvit Redis (sliding window) + in-memory baselines (rebuilt on cold start via `seedBaseline`).

## Demo

Total time: ~60 seconds.

1. **Install** the app on a test subreddit (here: `r/firefightermap_t_dev`).
2. **Subreddit menu → "FirefighterMap: seed demo fires"** — injects 40 synthetic events: a user burst (12 comments from one account over 8 minutes), a near-duplicate spam wave (8 fresh accounts posting near-identical promo text), and background chatter to populate the activity chart.
3. **Open the post.** Dashboard renders:
   - Hero: "1 fire burning hot." with activity sparkline + severity ring (1 high, 0 medium, 0 low)
   - Active fires: cards for `user_burst` and `near_duplicate_wave` with per-fire timelines
4. **Click "Send to modmail"** on the user_burst card → structured evidence lands in Mod Discussions:
   ```
   [FirefighterMap] User burst — HIGH (z=47.0)

   FirefighterMap detected a high-severity user burst in r/firefightermap_t_dev.
   u/demo_burst_user posted 47 times in 15min (z=47.0)

   Evidence
   - Subjects: `demo_burst_user`
   - Observed: 47
   - Baseline: 0.0 (z-score 47.00)
   - Composite score: 141.0
   - Detected at: 2026-05-21T...

   Sent from FirefighterMap. Statistical detection, no automated action taken.
   ```
5. **Click "Open in modqueue"** → host bridge navigates to the live modqueue outside the iframe.
6. **Click "Snooze 15m"** → fire hides for 15 minutes, toast confirms with the reappear time.

## Architecture decisions

| Choice | Why |
|---|---|
| **Statistical, not LLM** | Deterministic, no API key, sub-millisecond per scan, every flag is explainable to the moderator |
| **Devvit Web (HTTP server + webview)** | Replaces the older Blocks postMessage pattern. Triggers route directly to `/internal/trigger/*` HTTP endpoints. |
| **Redis sliding window per bucket** | `zAdd` + `zRangeByScore` gives O(log N) inserts and window queries. Survives cold starts; in-memory baselines don't. |
| **Welford online stats** | O(1) memory per bucket. No need to store the full history. |
| **MinHash K=64, FNV-1a** | Light hash, no crypto. K=64 gives ±~6% Jaccard estimate, sufficient for the `≥0.7` threshold. |
| **Mod-confirmed actions, no auto-remove** | A z-score is a signal, not a verdict. False positives are cheap (mod ignores card) instead of catastrophic (legitimate post removed). |
| **`@devvit/client` `navigateTo`** | Webview iframe is sandboxed; `window.open` and `<a target="_blank">` are blocked by the host. `navigateTo` uses Devvit's host bridge via `postMessage`. |

## Project layout

```
src/server/
  server.ts            HTTP routes: /internal/trigger/*, /api/fires, /api/snooze, /api/modmail
  core/
    detector.ts        Fire detection orchestrator (4 scan kinds)
    window.ts          Redis sliding-window store, countsByMinute for sparklines
    zscore.ts          Welford + adaptive z-score
    minhash.ts         FNV-1a MinHash signature + Jaccard estimate
    sharedDetector.ts  Module-level singleton (warm process)
    types.ts           Sensitivity presets (small_sub / medium_sub / large_sub)

src/client/
  splash.ts            Dashboard rendering: hero, ring, cards, actions

public/
  splash.html          Custom-post entry
  splash.css           Apple-grammar enterprise UI

tests/                 17 tests covering all four detectors + cold-start
devvit.json            Triggers, scheduler, menu actions, server config
```

## Install / dev

```bash
npm install
npm run dev          # devvit playtest, watches and redeploys
npm run type-check
npm run test         # vitest, 17 tests
npm run build
```

Playtest subreddit set in `devvit.json:dev.subreddit`.

## Roadmap (post-hackathon)

- **YAML config per subreddit** for sensitivity presets — mods expect tunable thresholds (table stakes per research)
- **Discord / Slack webhook alerts** — push fire events to a configured webhook; fsvreddit's queue-to-Discord pattern is the proof-point
- **Mod-confirmed bulk action** — "Review & remove the 8 posts in this cluster" modal; mod stays in the loop, audit trail clear
- **Cross-sub aggregation** — when the same author/text triggers fires in multiple subs in a network, escalate severity
- **Snapshot baselines to Redis** — survive cold starts without `seedBaseline` workaround
- **Usernotes / r/toolbox interop** — write the fire into the user's toolbox notes for cross-tool continuity

## License

MIT.
