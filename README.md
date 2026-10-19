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
- `js/engine.js` handles slots, team combinations, ratings by season or prime, team strength, and the match and season simulation.
- `js/app.js` handles the UI: home, setup, draft and season screens.

Ratings and squads are hand-curated fan estimates, so some squads are only partially listed.
