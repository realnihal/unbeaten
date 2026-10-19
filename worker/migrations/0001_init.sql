CREATE TABLE players (
  id TEXT PRIMARY KEY,              -- device UUID, kept secret in the browser
  nickname TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  seed TEXT NOT NULL,               -- draft seed, issued when the run starts
  season_seed TEXT,                 -- issued at submit time, so seasons can't be previewed
  engine_version TEXT NOT NULL,
  status TEXT NOT NULL,             -- drafting | complete | rejected
  reject_reason TEXT,
  settings TEXT NOT NULL,           -- JSON
  difficulty TEXT NOT NULL,
  era TEXT NOT NULL,
  rating_mode TEXT NOT NULL,
  ranked INTEGER NOT NULL,          -- 0 when the overseas cap is off
  actions TEXT,                     -- JSON draft log
  xi TEXT,                          -- JSON [{ slot, playerId, name, team, year, ovr }]
  wins INTEGER,
  losses INTEGER,
  position INTEGER,
  stage INTEGER,                    -- 0 none, 1 out in Eliminator, 2 out in Q2, 3 runner-up, 4 champion
  finish TEXT,
  nrr REAL,
  team_rating REAL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  ip_hash TEXT
);

CREATE INDEX runs_board ON runs (status, ranked, difficulty, completed_at);
CREATE INDEX runs_order ON runs (wins DESC, stage DESC, nrr DESC, completed_at);
CREATE INDEX runs_player ON runs (player_id, completed_at DESC);
CREATE INDEX runs_ip ON runs (ip_hash, created_at);
