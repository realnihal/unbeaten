# 14-0 · All-Time IPL XI

A cricket/IPL take on [38-0](https://38-0.app/). Spin the wheel to land on a real IPL franchise-season (2008–2025), draft one player from that squad, fill your XI (plus an Impact Player) under the 4-overseas rule, then simulate a 14-game league stage and the playoffs.

## Run

No build step. Serve the folder with any static server:

```bash
python3 -m http.server 5173
```

Then open http://localhost:5173.

## Files

- `js/data.js` holds franchises, plus each player's roles, peak batting/bowling ratings, peak season and franchise stints. Squads are derived from the stints.
- `js/engine.js` handles ratings, team strength, and the match and season simulation. All randomness goes through a seedable generator.
- `js/draft.js` holds the draft rules, shared by the browser and the server: spins, picks, moves, the overseas cap and replaying an action log.
- `js/app.js` handles the UI: home, setup, draft, live season, results, leaderboard and My runs.
- `js/config.js` sets the leaderboard API URL. When it's `null` the game runs fully offline (unranked).
- `worker/` is the leaderboard API: a Cloudflare Worker with a D1 database.
- `tests/` has the replay tests: `npm test`.

## Leaderboard

Runs are server-authoritative. Starting a draft asks the Worker for a seed, and every spin is derived from it. Submitting sends the action log; the Worker replays the draft (rejecting anything illegal), simulates the season with a fresh seed, stores the run and returns ranks. The browser then replays the same seeds locally for the playback, so the result is identical. See `docs/leaderboard-plan.md` for the design.

Local development:

```bash
cd worker
npx wrangler d1 migrations apply unbeaten --local
npx wrangler dev --port 8787
```

The game uses `http://localhost:8787` automatically when served from localhost.

## Deployment

Everything runs on Cloudflare under **unbeatenxi.tech** (domain registered at Hostinger, nameservers pointed to Cloudflare):

| What | Where | Deploy |
|---|---|---|
| Game site | https://unbeatenxi.tech (and www) | `npm run deploy:site` from the repo root (builds `dist/`, then deploys `wrangler.jsonc`) |
| Leaderboard API | https://api.unbeatenxi.tech | `cd worker && npm install && npm run deploy` |
| Database | D1 `unbeaten` (APAC) | Schema changes: new file in `worker/migrations/`, then `npm run migrate:remote` in `worker/` |

https://realnihal.github.io/unbeaten (GitHub Pages, updated on push to `master`) redirects to unbeatenxi.tech, carrying the player's saved data in the URL fragment so their nickname and runs follow them. The API's old workers.dev URL still works. When the API and the game logic change together, deploy the API first, then the site.

Analytics: Cloudflare injects Web Analytics automatically on unbeatenxi.tech.

**Changing ratings or rules:** player data changes bump `ENGINE_VERSION` automatically. For logic changes, bump `ENGINE_LOGIC_VERSION` in `js/engine.js` and redeploy the Worker, or replays will disagree.

Ratings and squads are hand-curated fan estimates, so some squads are only partially listed.
