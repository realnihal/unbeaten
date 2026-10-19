# Leaderboard, run storage & season playback plan

## Decisions

- **Backend:** Cloudflare Worker + D1 (SQLite). The site can stay on GitHub Pages and call the Worker's API.
- **Anti-cheat:** full server replay. The server issues the seed, replays every spin, reroll, pick and move, and simulates the season itself.
- **Identity:** anonymous device ID (UUID kept in browser storage) plus a nickname. Sign-in can come later.

## How a run works

1. `POST /runs` with `{ playerId, settings }` returns `{ runId, seed, engineVersion }`.
2. The client drafts with a seeded random-number generator. Every spin and reroll is derived from `seed`, and each player action is appended to an action log:
   `{ t: 'spin' } | { t: 'reroll' } | { t: 'pick', playerId, slot } | { t: 'move', from, to }`
3. `POST /runs/:id/submit` with `{ actions, nickname }`. The Worker:
   - replays the draft from `seed` and checks each spin landed on the franchise-season the client claims
   - validates each pick: the player was in that squad, the slot is eligible, the overseas cap holds, no duplicates, rerolls stay within the difficulty
   - validates moves using the same eligibility rules as the client
   - simulates the season with a seed derived from the run seed, stores the result, and returns it
4. The client renders the server's result. If the API is unreachable, the game falls back to a local simulation marked "unranked".

## Engine changes (shared by browser and Worker)

- Replace `Math.random` with an injected seeded generator (e.g. mulberry32) everywhere in `engine.js`.
- Move the spin pool, eligibility, overseas cap, reroll and move logic out of `app.js` into a pure `draft.js` that both sides import.
- Add an `ENGINE_VERSION` constant. The server replays each run with the version it was created under (or rejects runs from retired versions).
- Add a Node test: replay a recorded run and assert the result is identical.

## D1 schema

```sql
CREATE TABLE players (
  id TEXT PRIMARY KEY,            -- device UUID
  nickname TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  seed TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  status TEXT NOT NULL,           -- drafting | complete | rejected
  reject_reason TEXT,
  settings TEXT NOT NULL,         -- JSON
  actions TEXT,                   -- JSON draft log
  xi TEXT,                        -- JSON [{ playerId, team, year, slot }]
  wins INTEGER, losses INTEGER, position INTEGER,
  stage INTEGER,                  -- 0 none, 1 elim/Q2 exit, 2 runner-up, 3 champion
  finish TEXT, nrr REAL, team_rating REAL,
  difficulty TEXT, era TEXT,      -- copied out of settings so they can be indexed
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  ip_hash TEXT
);

CREATE INDEX runs_board ON runs (status, difficulty, completed_at, wins DESC, stage DESC, nrr DESC);
CREATE INDEX runs_player ON runs (player_id, completed_at DESC);
```

All completed runs are kept, including rejected ones, so you can run stats (most-drafted players, best franchise-seasons) and re-rank later.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/runs` | Start a run, issue a seed |
| POST | `/runs/:id/submit` | Replay, validate, simulate, store, return the result plus ranks |
| GET | `/leaderboard?period=day\|week\|all&difficulty=&era=&limit=50` | Ranked runs |
| GET | `/runs/:id` | One run, including its XI (for expanding a leaderboard row) |
| GET | `/players/:id/runs` | "My runs" history |
| PUT | `/players/:id` | Set or change nickname |

Ranking order: `wins DESC, stage DESC, nrr DESC, completed_at ASC`.

## Abuse limits

- Rate limit by IP hash: 30 started runs per hour.
- Nicknames: 3–20 characters, letters, numbers, spaces and `_-`, plus a basic profanity list.
- A run can be submitted only once, and only within 2 hours of starting.
- CORS restricted to the game's origin(s).

## Client UI

- **Results screen:** nickname prompt on the first run, then "Ranked #14 today · #3 this week (Hard)".
- **Leaderboard page:** Today / This week / All-time tabs, a difficulty filter and an era filter. Rows show rank, nickname, record, finish and 🏆. Tapping a row expands the XI.
- **My runs page:** this device's history.
- **Home:** a link to the leaderboard and top 3 of the day.

## Slow-roll season playback

The season is still simulated all at once (on the server once the leaderboard exists), but the client reveals it gradually by default instead of jumping straight to the results.

**Engine changes**
- Schedule the league as 14 rounds of 5 matches, so the table moves forward in step with the user's games, instead of one shuffled list.
- Log every match (not just the user's) as `{ round, home, away, innings, winner, margin }`, along with the user's scorecard highlights. The client rebuilds the points table step by step from this log. The full log also comes back from the server, so playback works for server-validated runs too.

**Live season screen** (between "Simulate season" and the results page)
- **Match card:** the current user match plays out over about 2 seconds. The first innings score ticks up, then the chase. Then it shows the result, margin, top batter and top bowler.
- **Live state:** the W-L record, the row of win/loss dots, and a points table that re-sorts after each round. Other teams' results in that round appear in a compact strip.
- **Playoffs:** slower and more dramatic, one game at a time with a short pause before each. If the user misses the top 4, the screen says so and then plays the rest of the playoffs quickly.
- **Controls:**
  - Pause/Resume, plus a speed toggle (1× / 2× / 4×). The chosen speed is remembered on the device.
  - **Skip to playoffs** reveals the rest of the league instantly, then continues the slow roll for the playoffs.
  - **Skip to end** goes straight to the results page.
- **Keyboard:** Space pauses or resumes, and → skips to the next match.
- **Accessibility:** if the device asks for reduced motion, skip the ticking scores and reveal one match per step.
- At the end it moves to the existing results page.

**Interaction with the leaderboard:** the run is submitted when "Simulate season" is pressed, before playback starts. The rank ("#14 today") only appears on the results page so it doesn't spoil playback. Skipping never changes the outcome.

## Build order

0. Slow-roll playback: round-based schedule, full match log, live season screen. This is independent and can ship first on GitHub Pages.
1. Engine refactor and replay test.
2. Worker + D1: schema migration, endpoints, validation.
3. Client: action log, server-authoritative results, nickname, offline fallback.
4. Leaderboard and My runs pages.
5. Deploy: `wrangler login` (you sign in), create the D1 database, deploy the Worker, point the client at its URL.
