// Leaderboard API. Runs are server-authoritative: the draft seed is issued here, the client
// sends back its action log, and the season is replayed and simulated here before storing.
import { ENGINE_VERSION, randomSeed } from '../../js/engine.js';
import { gameSettings, replayDraft, runSeason, summarize, xiSummary, DraftError } from '../../js/draft.js';

const RUNS_PER_HOUR = 30;
const SUBMIT_WINDOW_MS = 2 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLOCKED_WORDS = [
  'fuck', 'shit', 'bitch', 'cunt', 'nigg', 'fag', 'rape', 'slut', 'whore', 'dick', 'pussy', 'porn',
  'madarchod', 'behenchod', 'bhenchod', 'chutiya', 'chutia', 'gaand', 'lund', 'randi', 'bhosdi',
];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
    const cors = allowed.includes(origin) ? {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
      vary: 'origin',
    } : {};
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    let status = 200, body;
    try {
      body = await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) { status = e.status; body = { error: e.message }; }
      else { console.error(e); status = 500; body = { error: 'Server error' }; }
    }
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } });
  },
};

async function route(req, env) {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const m = req.method;

  if (m === 'POST' && parts[0] === 'runs' && parts.length === 1) return startRun(req, env);
  if (m === 'POST' && parts[0] === 'runs' && parts[2] === 'submit') return submitRun(req, env, parts[1]);
  if (m === 'GET' && parts[0] === 'runs' && parts.length === 2) return getRun(env, parts[1]);
  if (m === 'GET' && parts[0] === 'leaderboard') return leaderboard(env, url.searchParams);
  if (m === 'GET' && parts[0] === 'players' && parts[2] === 'runs') return playerRuns(env, parts[1]);
  if (m === 'PUT' && parts[0] === 'players' && parts.length === 2) return setNickname(req, env, parts[1]);
  if (m === 'GET' && parts.length === 0) return { ok: true, engineVersion: ENGINE_VERSION };
  throw new HttpError(404, 'Not found');
}

// ---------- Helpers ----------

async function readJson(req) {
  try { return await req.json(); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

function playerIdFrom(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, 'Invalid player id');
  return value.toLowerCase();
}

async function ipHash(req, env) {
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  const data = new TextEncoder().encode(`${env.IP_SALT || 'dev-salt'}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function cleanNickname(raw) {
  if (typeof raw !== 'string') throw new HttpError(400, 'Nickname required');
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < 3 || name.length > 20) throw new HttpError(400, 'Nickname must be 3–20 characters');
  if (!/^[A-Za-z0-9 _-]+$/.test(name)) throw new HttpError(400, 'Use letters, numbers, spaces, _ or -');
  const flat = name.toLowerCase().replace(/[^a-z]/g, '').replace(/0/g, 'o');
  if (BLOCKED_WORDS.some(w => flat.includes(w))) throw new HttpError(400, 'Please pick a different nickname');
  return name;
}

async function ensurePlayer(env, id) {
  await env.DB.prepare('INSERT OR IGNORE INTO players (id, nickname, created_at) VALUES (?1, NULL, ?2)').bind(id, Date.now()).run();
}

// Period starts use Indian Standard Time: "today" resets at midnight IST, "this week" on Monday.
function periodStart(period, now = Date.now()) {
  if (period === 'all') return 0;
  const ist = new Date(now + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  if (period === 'week') ist.setUTCDate(ist.getUTCDate() - ((ist.getUTCDay() + 6) % 7));
  return ist.getTime() - IST_OFFSET_MS;
}

const RANK_ORDER = 'wins DESC, stage DESC, nrr DESC, completed_at ASC';

// Number of ranked runs that beat the given one, + 1.
async function rankOf(env, run, since, era = null) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS better FROM runs
    WHERE status = 'complete' AND ranked = 1 AND difficulty = ?1 AND completed_at >= ?2
      AND (?7 IS NULL OR era = ?7)
      AND (wins > ?3 OR (wins = ?3 AND (stage > ?4 OR (stage = ?4 AND (nrr > ?5 OR (nrr = ?5 AND completed_at < ?6))))))
  `).bind(run.difficulty, since, run.wins, run.stage, run.nrr, run.completed_at, era).first();
  return row.better + 1;
}

const publicRow = r => ({
  runId: r.id, nickname: r.nickname || 'Anonymous', wins: r.wins, losses: r.losses, finish: r.finish,
  stage: r.stage, position: r.position, nrr: r.nrr, teamRating: r.team_rating, difficulty: r.difficulty,
  era: r.era, ratingMode: r.rating_mode, completedAt: r.completed_at,
});

// ---------- Handlers ----------

async function startRun(req, env) {
  const body = await readJson(req);
  const playerId = playerIdFrom(body.playerId);
  if (body.engineVersion !== ENGINE_VERSION) {
    throw new HttpError(409, `Game updated. Refresh to play a ranked run (server ${ENGINE_VERSION}).`);
  }
  const settings = gameSettings(body.settings || {});
  const hash = await ipHash(req, env);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE ip_hash = ?1 AND created_at > ?2')
    .bind(hash, Date.now() - 60 * 60 * 1000).first();
  if (recent.n >= RUNS_PER_HOUR) throw new HttpError(429, 'Too many runs this hour. Try again later.');

  await ensurePlayer(env, playerId);
  const runId = crypto.randomUUID();
  const seed = randomSeed();
  await env.DB.prepare(`
    INSERT INTO runs (id, player_id, seed, engine_version, status, settings, difficulty, era, rating_mode, ranked, created_at, ip_hash)
    VALUES (?1, ?2, ?3, ?4, 'drafting', ?5, ?6, ?7, ?8, ?9, ?10, ?11)
  `).bind(runId, playerId, seed, ENGINE_VERSION, JSON.stringify(settings), settings.difficulty, settings.era,
    settings.ratingMode, settings.overseasCap ? 1 : 0, Date.now(), hash).run();
  return { runId, seed, settings, engineVersion: ENGINE_VERSION };
}

async function submitRun(req, env, runId) {
  const body = await readJson(req);
  const playerId = playerIdFrom(body.playerId);
  const run = await env.DB.prepare('SELECT * FROM runs WHERE id = ?1').bind(runId).first();
  if (!run || run.player_id !== playerId) throw new HttpError(404, 'Run not found');
  if (run.status !== 'drafting') throw new HttpError(409, 'Run already submitted');
  if (Date.now() - run.created_at > SUBMIT_WINDOW_MS) throw new HttpError(410, 'Run expired');
  if (run.engine_version !== ENGINE_VERSION) throw new HttpError(409, 'Game updated since this run started');

  const settings = JSON.parse(run.settings);
  let draft;
  try {
    draft = replayDraft(settings, run.seed, body.actions);
  } catch (e) {
    if (!(e instanceof DraftError)) throw e;
    await env.DB.prepare(`UPDATE runs SET status = 'rejected', reject_reason = ?2, actions = ?3, completed_at = ?4 WHERE id = ?1`)
      .bind(runId, e.message, JSON.stringify(body.actions ?? null).slice(0, 20000), Date.now()).run();
    throw new HttpError(422, `Run could not be verified: ${e.message}`);
  }

  const seasonSeed = randomSeed();
  const summary = summarize(runSeason(draft, seasonSeed));
  const completedAt = Date.now();
  await env.DB.prepare(`
    UPDATE runs SET status = 'complete', season_seed = ?2, actions = ?3, xi = ?4, wins = ?5, losses = ?6,
      position = ?7, stage = ?8, finish = ?9, nrr = ?10, team_rating = ?11, completed_at = ?12
    WHERE id = ?1
  `).bind(runId, seasonSeed, JSON.stringify(draft.actions), JSON.stringify(xiSummary(draft)), summary.wins, summary.losses,
    summary.position, summary.stage, summary.finish, summary.nrr, summary.teamRating, completedAt).run();

  const stored = { ...run, ...summary, completed_at: completedAt };
  const ranks = run.ranked ? {
    day: await rankOf(env, stored, periodStart('day')),
    week: await rankOf(env, stored, periodStart('week')),
    all: await rankOf(env, stored, 0),
  } : null;
  return { seasonSeed, summary, ranks, ranked: !!run.ranked, difficulty: run.difficulty };
}

async function getRun(env, runId) {
  const r = await env.DB.prepare(`
    SELECT runs.*, players.nickname FROM runs JOIN players ON players.id = runs.player_id
    WHERE runs.id = ?1 AND runs.status = 'complete'
  `).bind(runId).first();
  if (!r) throw new HttpError(404, 'Run not found');
  return { ...publicRow(r), settings: JSON.parse(r.settings), xi: JSON.parse(r.xi) };
}

async function leaderboard(env, params) {
  const period = ['day', 'week', 'all'].includes(params.get('period')) ? params.get('period') : 'day';
  const difficulty = ['easy', 'normal', 'hard'].includes(params.get('difficulty')) ? params.get('difficulty') : 'normal';
  const era = params.get('era') && params.get('era') !== 'any' ? params.get('era') : null;
  const limit = Math.min(100, Math.max(1, Number(params.get('limit')) || 50));
  const since = periodStart(period);

  const { results } = await env.DB.prepare(`
    SELECT runs.*, players.nickname FROM runs JOIN players ON players.id = runs.player_id
    WHERE status = 'complete' AND ranked = 1 AND difficulty = ?1 AND completed_at >= ?2 AND (?3 IS NULL OR era = ?3)
    ORDER BY ${RANK_ORDER} LIMIT ?4
  `).bind(difficulty, since, era, limit).all();

  const rows = results.map((r, i) => ({ rank: i + 1, ...publicRow(r) }));
  let you = null;
  const playerId = params.get('playerId');
  if (playerId && UUID.test(playerId)) {
    const best = await env.DB.prepare(`
      SELECT runs.*, players.nickname FROM runs JOIN players ON players.id = runs.player_id
      WHERE player_id = ?1 AND status = 'complete' AND ranked = 1 AND difficulty = ?2 AND completed_at >= ?3 AND (?4 IS NULL OR era = ?4)
      ORDER BY ${RANK_ORDER} LIMIT 1
    `).bind(playerId.toLowerCase(), difficulty, since, era).first();
    if (best) you = { rank: await rankOf(env, best, since, era), ...publicRow(best) };
  }
  const total = await env.DB.prepare(`
    SELECT COUNT(*) AS n FROM runs WHERE status = 'complete' AND ranked = 1 AND difficulty = ?1 AND completed_at >= ?2 AND (?3 IS NULL OR era = ?3)
  `).bind(difficulty, since, era).first();
  return { period, difficulty, era: era ?? 'any', since, total: total.n, rows, you };
}

async function playerRuns(env, rawId) {
  const playerId = playerIdFrom(rawId);
  const player = await env.DB.prepare('SELECT nickname FROM players WHERE id = ?1').bind(playerId).first();
  const { results } = await env.DB.prepare(`
    SELECT runs.*, players.nickname FROM runs JOIN players ON players.id = runs.player_id
    WHERE player_id = ?1 AND status = 'complete' ORDER BY completed_at DESC LIMIT 50
  `).bind(playerId).all();
  return {
    nickname: player?.nickname ?? null,
    runs: results.map(r => ({ ...publicRow(r), ranked: !!r.ranked, xi: JSON.parse(r.xi) })),
  };
}

async function setNickname(req, env, rawId) {
  const playerId = playerIdFrom(rawId);
  const { nickname } = await readJson(req);
  const name = cleanNickname(nickname);
  await env.DB.prepare(`
    INSERT INTO players (id, nickname, created_at) VALUES (?1, ?2, ?3)
    ON CONFLICT(id) DO UPDATE SET nickname = excluded.nickname
  `).bind(playerId, name, Date.now()).run();
  return { nickname: name };
}
