import { TEAMS, RAW_PLAYERS, FIRST_SEASON, LAST_SEASON } from './data.js';

// ---------- Slots & team combinations ----------

export const SLOTS = {
  OPN: { label: 'Opener', short: 'OPN', kind: 'bat' },
  BAT: { label: 'Middle Order', short: 'MID', kind: 'bat' },
  WK:  { label: 'Wicketkeeper', short: 'WK', kind: 'wk' },
  FIN: { label: 'Finisher', short: 'FIN', kind: 'bat' },
  AR:  { label: 'All-Rounder', short: 'AR', kind: 'ar' },
  SPN: { label: 'Spinner', short: 'SPIN', kind: 'bowl' },
  PAC: { label: 'Pace Bowler', short: 'PACE', kind: 'bowl' },
  IMP: { label: 'Impact Player', short: 'IMP', kind: 'imp' },
};

// Which slots each role letter unlocks. Openers can also bat in the middle order.
const ROLE_SLOTS = { O: ['OPN', 'BAT'], B: ['BAT'], W: ['WK'], F: ['FIN'], A: ['AR'], S: ['SPN'], P: ['PAC'] };

export const COMBOS = [
  { id: 'balanced', name: 'Balanced', desc: 'Two all-rounders give you six bowling options and batting down to eight.',
    slots: ['OPN', 'OPN', 'BAT', 'BAT', 'WK', 'FIN', 'AR', 'AR', 'SPN', 'PAC', 'PAC'] },
  { id: 'batting', name: 'Batting Depth', desc: 'Five specialist batters. Pile on runs, then defend with five bowlers.',
    slots: ['OPN', 'OPN', 'BAT', 'BAT', 'BAT', 'WK', 'FIN', 'AR', 'SPN', 'PAC', 'PAC'] },
  { id: 'pace', name: 'Pace Battery', desc: 'Three quicks to blast through the powerplay and the death.',
    slots: ['OPN', 'OPN', 'BAT', 'BAT', 'WK', 'FIN', 'AR', 'SPN', 'PAC', 'PAC', 'PAC'] },
  { id: 'spin', name: 'Spin Web', desc: 'Two frontline spinners to choke the middle overs.',
    slots: ['OPN', 'OPN', 'BAT', 'WK', 'BAT', 'FIN', 'AR', 'SPN', 'SPN', 'PAC', 'PAC'] },
  { id: 'allround', name: 'All-Rounder Army', desc: 'Three all-rounders. Depth everywhere, specialists nowhere.',
    slots: ['OPN', 'OPN', 'BAT', 'WK', 'AR', 'AR', 'AR', 'FIN', 'SPN', 'PAC', 'PAC'] },
  { id: 'hitters', name: 'Power Hitters', desc: 'Two finishers to launch the last five overs.',
    slots: ['OPN', 'OPN', 'BAT', 'WK', 'FIN', 'FIN', 'AR', 'SPN', 'PAC', 'PAC', 'PAC'] },
];

export const ERAS = [
  { id: 'all', name: 'All-time', from: FIRST_SEASON, to: LAST_SEASON },
  { id: 'early', name: '2008–12', from: 2008, to: 2012 },
  { id: 'middle', name: '2013–17', from: 2013, to: 2017 },
  { id: 'modern', name: '2018+', from: 2018, to: LAST_SEASON },
  { id: 'impact', name: '2022+', from: 2022, to: LAST_SEASON },
];

export const MAX_OVERSEAS = 4;
// Bump the prefix whenever draft or simulation logic changes; the data hash changes on its own.
export const ENGINE_LOGIC_VERSION = 1;
export const LEAGUE_GAMES = 14;

// ---------- Players & squads ----------

function primaryRole(roles) {
  if (roles.includes('A')) return 'AR';
  if (roles.includes('W')) return 'WK';
  if (/[PS]/.test(roles) && !/[OBF]/.test(roles)) return 'BOWL';
  return 'BAT';
}

export const PLAYERS = RAW_PLAYERS.map(([name, country, roles, bat, bowl, peak, stints], id) => ({
  id, name, country, roles, bat, bowl, peak,
  overseas: country !== 'IND',
  role: primaryRole(roles),
  slots: [...new Set([...roles].flatMap(r => ROLE_SLOTS[r]))],
  stints: stints.split(',').map(s => {
    const [team, range] = s.trim().split(' ');
    const [from, to] = range.split('-').map(Number);
    return { team, from, to: to ?? from };
  }),
}));

export function teamActive(team, year) {
  return TEAMS[team].spans.some(([a, b]) => year >= a && year <= b);
}

const SQUADS = new Map();
for (const p of PLAYERS) {
  for (const st of p.stints) {
    if (!TEAMS[st.team]) { console.warn('Unknown team', st.team, p.name); continue; }
    for (let y = st.from; y <= st.to; y++) {
      if (!teamActive(st.team, y)) { console.warn('Inactive team-season', st.team, y, p.name); continue; }
      const key = `${st.team}|${y}`;
      if (!SQUADS.has(key)) SQUADS.set(key, []);
      SQUADS.get(key).push(p);
    }
  }
}

export function squad(team, year) {
  return SQUADS.get(`${team}|${year}`) ?? [];
}

export function teamSeasons(era) {
  const out = [];
  for (const team of Object.keys(TEAMS)) {
    for (let y = era.from; y <= era.to; y++) {
      if (teamActive(team, y) && squad(team, y).length >= 7) out.push({ team, year: y });
    }
  }
  return out;
}

export const ENGINE_VERSION = `${ENGINE_LOGIC_VERSION}-${hashString(JSON.stringify(RAW_PLAYERS)).toString(36)}`;

export const STATS = {
  players: PLAYERS.length,
  franchises: Object.keys(TEAMS).length,
  squads: SQUADS.size,
};

export function teamName(team, year) { return TEAMS[team].name(year); }
export function teamShort(team, year) { return TEAMS[team].short(year); }
export function teamColor(team) { return TEAMS[team].color; }
export function seasonTag(team, year) { return `${teamShort(team, year)} '${String(year).slice(2)}`; }

// ---------- Ratings ----------

function taper(base, year, peak) {
  if (!base) return 0;
  const d = year - peak;
  return Math.max(55, Math.round(base - (d < 0 ? -d * 1.6 : d * 1.1)));
}

export function ratingsFor(p, year, mode) {
  if (mode === 'prime') return { bat: p.bat, bowl: p.bowl };
  return { bat: taper(p.bat, year, p.peak), bowl: taper(p.bowl, year, p.peak) };
}

export function overall(p, r) {
  if (p.role === 'AR') {
    const hi = Math.max(r.bat, r.bowl), lo = Math.min(r.bat, r.bowl);
    return Math.min(99, Math.round(hi * 0.65 + lo * 0.35 + 3));
  }
  return p.role === 'BOWL' ? r.bowl : r.bat;
}

// ---------- Team strength ----------

const BAT_W = [1.25, 1.2, 1.15, 1.05, 0.95, 0.85, 0.7];
const BOWL_W = [1.2, 1.1, 1.0, 0.95, 0.9];

// members: [{ p, r }]. `pad` fills empty spots (opponent squads are only partially listed).
export function teamStrength(members, pad = null) {
  const list = [...members];
  if (pad) while (list.length < 11) list.push({ p: { roles: '' }, r: { bat: pad, bowl: pad } });

  const bats = list.map(m => m.r.bat || 30).sort((a, b) => b - a);
  let s = 0, w = 0;
  BAT_W.forEach((wt, i) => { s += (bats[i] ?? 30) * wt; w += wt; });
  const bat = s / w + ((bats[7] ?? 30) - 60) * 0.04;

  const bowlers = list.filter(m => m.r.bowl > 0).sort((a, b) => b.r.bowl - a.r.bowl);
  s = 0; w = 0;
  BOWL_W.forEach((wt, i) => { s += (bowlers[i]?.r.bowl ?? 48) * wt; w += wt; });
  let bowl = s / w;
  const top6 = bowlers.slice(0, 6);
  const hasSpin = top6.some(m => m.p.roles.includes('S'));
  const pace = top6.filter(m => m.p.roles.includes('P')).length;
  if (!pad && !hasSpin) bowl -= 2.5;
  if (!pad && pace < 2) bowl -= 2.5;

  return { bat, bowl, ovr: (bat + bowl) / 2, bowlingOptions: bowlers.filter(m => m.r.bowl >= 60).length };
}

// Best XI an opponent franchise-season would field: max 4 overseas, a keeper if available.
function opponentXI(team, year, mode) {
  const pool = squad(team, year)
    .map(p => ({ p, r: ratingsFor(p, year, mode) }))
    .map(m => ({ ...m, o: overall(m.p, m.r) }))
    .sort((a, b) => b.o - a.o);
  const xi = [];
  let overseas = 0;
  const keeper = pool.find(m => m.p.roles.includes('W'));
  if (keeper) { xi.push(keeper); if (keeper.p.overseas) overseas++; }
  for (const m of pool) {
    if (xi.length >= 11) break;
    if (xi.includes(m)) continue;
    if (m.p.overseas && overseas >= MAX_OVERSEAS) continue;
    if (m.p.overseas) overseas++;
    xi.push(m);
  }
  return xi;
}

export function buildOpponents(era, mode, count = 9) {
  const seasons = shuffle(teamSeasons(era).filter(ts => squad(ts.team, ts.year).length >= 9));
  const used = new Set();
  const picks = [];
  for (const ts of seasons) {
    if (picks.length >= count) break;
    if (used.has(ts.team)) continue;
    used.add(ts.team);
    picks.push(ts);
  }
  for (const ts of seasons) { if (picks.length >= count) break; if (!picks.includes(ts)) picks.push(ts); }

  return picks.map(({ team, year }) => {
    const xi = opponentXI(team, year, mode);
    const st = teamStrength(xi, 75);
    return {
      id: `${team}-${year}`, team, year,
      name: `${teamName(team, year)} ${year}`, short: seasonTag(team, year), color: teamColor(team),
      // Small boost for the unlisted squad depth every real side had.
      bat: st.bat + 1.5, bowl: st.bowl + 1.5, ovr: st.ovr + 1.5,
      stars: [...xi].sort((a, b) => b.o - a.o).slice(0, 3).map(m => m.p.name),
    };
  });
}

// ---------- Match simulation ----------

// All randomness goes through `rand`, which can be swapped for a seeded generator so the
// browser and the server produce identical drafts and seasons. Only +, −, ×, ÷ and rounding
// are used on random values (no Math.log/cos/pow), because those can differ by a bit across
// JavaScript engines and would break replays.
let rand = Math.random;

export function withRng(rng, fn) {
  const prev = rand;
  rand = rng;
  try { return fn(); } finally { rand = prev; }
}

// String → 32-bit hash (cyrb53, folded) → mulberry32 generator.
export function hashString(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

export function rngFrom(seed) {
  let a = hashString(String(seed));
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Approximately standard normal (Irwin–Hall: sum of 12 uniforms minus 6).
function gauss() {
  let s = -6;
  for (let i = 0; i < 12; i++) s += rand();
  return s;
}
const pow5 = x => x * x * x * x * x;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const randInt = (a, b) => a + Math.floor(rand() * (b - a + 1));
export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function potential(bat, bowl) {
  return Math.round(clamp(170 + (bat - bowl) * 2.2 + gauss() * 24, 85, 272));
}
function wicketsFor(bat, bowl, runs) {
  return clamp(Math.round(6.2 - (bat - bowl) * 0.12 - (runs - 170) / 30 + gauss() * 1.6), 1, 10);
}

export function overs(balls) {
  return balls % 6 === 0 ? `${balls / 6}` : `${Math.floor(balls / 6)}.${balls % 6}`;
}

export function playMatch(A, B) {
  const aFirst = rand() < 0.5;
  const first = aFirst ? A : B, second = aFirst ? B : A;

  const r1 = potential(first.bat, second.bowl);
  const w1 = wicketsFor(first.bat, second.bowl, r1);
  const b1 = w1 === 10 ? randInt(96, 119) : 120;

  const cap = potential(second.bat, first.bowl);
  const capW = wicketsFor(second.bat, first.bowl, cap);
  let r2, w2, b2, winner, margin;

  if (cap > r1) {
    const ratio = (r1 + 1) / cap;
    r2 = r1 + 1 + (rand() < 0.35 ? randInt(1, 5) : 0);
    b2 = clamp(Math.round(120 * ratio + gauss() * 4), 66, 120);
    w2 = clamp(Math.round(capW * ratio), 0, 9);
    winner = second;
    const wk = 10 - w2;
    margin = `${wk} wicket${wk === 1 ? '' : 's'}`;
  } else {
    r2 = cap;
    w2 = capW;
    b2 = w2 === 10 ? randInt(88, 119) : 120;
    if (cap < r1) {
      winner = first;
      const runs = r1 - r2;
      margin = `${runs} run${runs === 1 ? '' : 's'}`;
    } else {
      const edge = 0.5 + (first.ovr - second.ovr) * 0.03;
      winner = rand() < edge ? first : second;
      margin = 'Super Over';
    }
  }

  return {
    first: first.id, second: second.id, winner: winner.id, margin,
    inn: [
      { team: first.id, runs: r1, wkts: w1, balls: b1, nrrBalls: w1 === 10 ? 120 : b1 },
      { team: second.id, runs: r2, wkts: w2, balls: b2, nrrBalls: w2 === 10 ? 120 : b2 },
    ],
  };
}

// ---------- Player performances for the user's XI ----------

const POS_W = [1.3, 1.3, 1.2, 1.1, 1.0, 0.9, 0.8, 0.6, 0.5, 0.4, 0.4];

function battingCard(order, runs, wkts) {
  const batted = order.slice(0, Math.min(order.length, wkts + 2));
  const weights = batted.map((m, i) => pow5((m.r.bat || 30) / 70) * POS_W[i] * (0.25 + rand() * 1.5));
  const total = weights.reduce((a, b) => a + b, 0);
  const pool = runs - Math.round(runs * 0.06);
  const card = batted.map((m, i) => ({ m, runs: Math.floor(pool * weights[i] / total) }));
  let left = pool - card.reduce((a, c) => a + c.runs, 0);
  for (let i = 0; left > 0; i = (i + 1) % card.length, left--) card[i].runs++;
  for (const c of card) {
    const sr = clamp(118 + ((c.m.r.bat || 30) - 60) * 1.6 + gauss() * 22, 70, 260);
    c.balls = Math.max(1, Math.round(c.runs * 100 / sr));
  }
  return card;
}

function bowlingCard(bowlers, wkts, runsConceded) {
  const five = bowlers.slice(0, 5);
  const card = five.map(m => ({ m, wkts: 0, runs: 0 }));
  const weights = five.map(m => pow5(m.r.bowl / 70));
  for (let k = 0; k < wkts; k++) {
    const jittered = weights.map(w => w * (0.3 + rand() * 1.4));
    const sum = jittered.reduce((a, b) => a + b, 0);
    let x = rand() * sum, i = 0;
    while (x > jittered[i] && i < jittered.length - 1) { x -= jittered[i]; i++; }
    card[i].wkts++;
  }
  const econW = five.map(m => (80 / m.r.bowl) * (80 / m.r.bowl) * (0.6 + rand() * 0.8));
  const ew = econW.reduce((a, b) => a + b, 0);
  card.forEach((c, i) => { c.runs = Math.round(runsConceded * 0.95 * econW[i] / ew); });
  return card;
}

// ---------- Season ----------

// Circle-method round robin: 9 rounds where everyone meets once, then 5 of those rounds
// replayed with home and away swapped. 14 rounds, one game per team per round.
function leagueRounds(ids) {
  const ring = shuffle(ids);
  const n = ring.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const round = [];
    for (let i = 0; i < n / 2; i++) {
      const a = ring[i], b = ring[n - 1 - i];
      round.push(r % 2 ? [b, a] : [a, b]);
    }
    rounds.push(round);
    ring.splice(1, 0, ring.pop());
  }
  const repeats = shuffle(rounds).slice(0, LEAGUE_GAMES - (n - 1)).map(rd => rd.map(([h, a]) => [a, h]));
  return [...shuffle(rounds), ...shuffle(repeats)];
}

// Points table from a list of league matches ({ res } from playMatch), sorted by points then NRR.
export function standings(teams, matches) {
  const table = Object.fromEntries(teams.map(t => [t.id, { id: t.id, team: t, p: 0, w: 0, l: 0, pts: 0, rf: 0, bf: 0, ra: 0, bb: 0 }]));
  for (const { res } of matches) {
    for (const inn of res.inn) {
      const other = res.inn.find(i => i !== inn);
      const row = table[inn.team];
      row.rf += inn.runs; row.bf += inn.nrrBalls; row.ra += other.runs; row.bb += other.nrrBalls;
      row.p++;
      if (res.winner === inn.team) { row.w++; row.pts += 2; } else row.l++;
    }
  }
  return Object.values(table)
    .map(r => ({ ...r, nrr: r.bf ? r.rf / (r.bf / 6) - r.ra / (r.bb / 6) : 0 }))
    .sort((a, b) => b.pts - a.pts || b.nrr - a.nrr);
}

// user: { id: 'YOU', name, bat, bowl, ovr, order: [{p,r}], bowlers: [{p,r}] }
export function simulateSeason(user, opponents) {
  const teams = [user, ...opponents];
  const byId = Object.fromEntries(teams.map(t => [t.id, t]));

  const stats = new Map();
  const stat = p => {
    if (!stats.has(p.id)) stats.set(p.id, { p, runs: 0, balls: 0, inns: 0, hs: 0, wkts: 0, conceded: 0, best: null });
    return stats.get(p.id);
  };
  const log = [];

  const userMatch = (res, stage, round = null) => {
    const userInn = res.inn.find(i => i.team === user.id);
    const oppInn = res.inn.find(i => i.team !== user.id);
    const bat = battingCard(user.order, userInn.runs, userInn.wkts);
    const bowl = bowlingCard(user.bowlers, oppInn.wkts, oppInn.runs);
    for (const c of bat) {
      const s = stat(c.m.p);
      s.runs += c.runs; s.balls += c.balls; s.inns++; s.hs = Math.max(s.hs, c.runs);
    }
    for (const c of bowl) {
      const s = stat(c.m.p);
      s.wkts += c.wkts; s.conceded += c.runs;
      if (!s.best || c.wkts > s.best.w || (c.wkts === s.best.w && c.runs < s.best.r)) s.best = { w: c.wkts, r: c.runs };
    }
    const topBat = [...bat].sort((a, b) => b.runs - a.runs)[0];
    const topBowl = [...bowl].sort((a, b) => b.wkts - a.wkts || a.runs - b.runs)[0];
    const oppId = res.first === user.id ? res.second : res.first;
    log.push({
      stage, round, opp: byId[oppId], won: res.winner === user.id, margin: res.margin,
      battedFirst: res.first === user.id, userInn, oppInn,
      topBat: { name: topBat.m.p.name, runs: topBat.runs, balls: topBat.balls },
      topBowl: { name: topBowl.m.p.name, wkts: topBowl.wkts, runs: topBowl.runs },
    });
  };

  const matches = [];
  leagueRounds(teams.map(t => t.id)).forEach((round, r) => {
    for (const [home, away] of round) {
      const res = playMatch(byId[home], byId[away]);
      matches.push({ round: r, home, away, res });
      if (home === user.id || away === user.id) userMatch(res, 'League', r);
    }
  });

  const rows = standings(teams, matches);
  const position = rows.findIndex(r => r.id === user.id) + 1;

  // Playoffs
  const playoffs = [];
  const play = (label, a, b) => {
    const res = playMatch(a, b);
    const involved = a.id === user.id || b.id === user.id;
    if (involved) userMatch(res, label);
    const win = byId[res.winner], lose = win === a ? b : a;
    playoffs.push({ label, a, b, res, win, lose, involved });
    return { win, lose };
  };
  const [t1, t2, t3, t4] = rows.slice(0, 4).map(r => r.team);
  const q1 = play('Qualifier 1', t1, t2);
  const el = play('Eliminator', t3, t4);
  const q2 = play('Qualifier 2', q1.lose, el.win);
  const fin = play('Final', q1.win, q2.win);

  let finish;
  if (fin.win.id === user.id) finish = 'Champions';
  else if (fin.lose.id === user.id) finish = 'Runners-up';
  else if (q2.lose.id === user.id) finish = 'Out in Qualifier 2';
  else if (el.lose.id === user.id) finish = 'Out in the Eliminator';
  else finish = `Finished ${ordinal(position)}`;

  const league = log.filter(m => m.stage === 'League');
  const w = league.filter(m => m.won).length;
  const all = [...stats.values()];
  const orange = [...all].sort((a, b) => b.runs - a.runs)[0];
  const purple = [...all].sort((a, b) => b.wkts - a.wkts || a.conceded - b.conceded)[0];
  const mvp = [...all].sort((a, b) => (b.runs + b.wkts * 25) - (a.runs + a.wkts * 25))[0];

  return {
    teams, matches, wins: w, losses: league.length - w, position, rows, log, playoffs, finish,
    champion: finish === 'Champions',
    perfectLeague: w === LEAGUE_GAMES,
    perfectSeason: w === LEAGUE_GAMES && log.every(m => m.won),
    orange, purple, mvp, champion_team: fin.win,
  };
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
