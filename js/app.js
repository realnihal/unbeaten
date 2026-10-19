import {
  SLOTS, COMBOS, ERAS, MAX_OVERSEAS, LEAGUE_GAMES, PLAYERS, STATS, ENGINE_VERSION,
  squad, teamSeasons, teamName, teamColor, seasonTag,
  ratingsFor, overall, standings, overs, ordinal, shuffle, randomSeed,
} from './engine.js';
import * as D from './draft.js';
import { FIRST_SEASON, LAST_SEASON } from './data.js';
import { API_BASE } from './config.js';

const DIFFICULTY = D.DIFFICULTY;

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`ipl14-${key}`); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`ipl14-${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const S = {
  screen: 'home',
  settings: {
    combo: 'balanced', difficulty: 'normal', showRatings: true, draftMode: 'squad',
    ratingMode: 'season', era: 'all', impact: true, overseasCap: true, playSpeed: 1,
    ...store.get('settings', {}),
  },
  draft: null,
  run: null,          // { runId, seed, ranked, note } for the current draft
  result: null,
  opponents: null,
  modal: null,        // 'nickname-sim' | 'nickname-edit'
  modalError: null,
  starting: false,
  submitting: false,
  lb: { period: 'day', difficulty: 'normal', era: 'any', status: 'idle', data: null, open: null, details: {} },
  mine: { status: 'idle', data: null, open: null },
  top3: { status: 'idle', data: null, at: 0 },
};

const app = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ratingsVisible = () => S.settings.difficulty !== 'hard' && S.settings.showRatings;
const era = () => ERAS.find(e => e.id === S.settings.era) ?? ERAS[0];
const combo = () => COMBOS.find(c => c.id === S.settings.combo) ?? COMBOS[0];

function go(screen) {
  if (screen !== 'live') stopPlayback();
  S.screen = screen;
  render();
  window.scrollTo({ top: 0 });
  if (screen === 'leaderboard' && API_BASE) loadLeaderboard();
  if (screen === 'myruns' && API_BASE) loadMyRuns();
  if (screen === 'home') loadTop3();
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------- Player identity & API ----------

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function playerId() {
  let id = store.get('playerId', null);
  if (!id) { id = crypto.randomUUID(); store.set('playerId', id); }
  return id;
}

async function api(path, { method = 'GET', body, timeout = 8000 } = {}) {
  if (!API_BASE) throw new ApiError(0, 'Leaderboard is offline.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(API_BASE + path, {
      method, signal: ctrl.signal,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
    return data;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, 'Could not reach the leaderboard.');
  } finally {
    clearTimeout(timer);
  }
}

const UNRANKED_NOTES = {
  offline: 'Unranked: the leaderboard could not be reached.',
  outdated: 'Unranked: the game was updated. Refresh the page to play ranked runs.',
  ratelimit: 'Unranked: too many runs this hour.',
  rejected: 'Unranked: this run could not be verified.',
  nocap: 'Saved, but not ranked: the overseas limit was off.',
};

// ---------- Draft ----------
// The rules live in draft.js (shared with the server). Every change to the draft goes
// through `act`, which also appends to the action log that gets submitted.

async function startRun() {
  if (S.starting) return;
  const settings = D.gameSettings(S.settings);
  let run = { runId: null, seed: randomSeed(), ranked: false, note: API_BASE ? 'offline' : null };
  if (API_BASE) {
    S.starting = true;
    render();
    try {
      const res = await api('/runs', { method: 'POST', body: { playerId: playerId(), settings, engineVersion: ENGINE_VERSION } });
      run = { runId: res.runId, seed: res.seed, ranked: settings.overseasCap, note: settings.overseasCap ? null : 'nocap' };
    } catch (e) {
      run.note = e.status === 409 ? 'outdated' : e.status === 429 ? 'ratelimit' : 'offline';
      toast(`${e.message} This run won't be ranked.`);
    }
    S.starting = false;
  }
  S.run = run;
  S.draft = Object.assign(D.createDraft(settings, run.seed), { spinning: false, selected: null, moving: null, sort: 'rating' });
  go('draft');
}

function act(action) {
  try {
    D.applyAction(S.draft, action);
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

const posMode = () => S.draft.settings.draftMode === 'position';
const picks = () => D.picks(S.draft);
const openSlots = () => D.openSlots(S.draft);
const overseasCount = () => D.overseasCount(S.draft);
const slotsFor = p => D.slotsFor(S.draft, p);
const blockReason = p => D.blockReason(S.draft, p);
const moveTargets = idx => D.moveTargets(S.draft, idx);
const userTeam = () => D.userTeam(S.draft);
const squadShown = () => S.draft.spin && !S.draft.spinning;

// Drafted players can be moved at any time except mid-spin, while choosing a squad player,
// or while a Position First spin is waiting to fill its target.
function canMove() {
  const d = S.draft;
  return !d.spinning && d.selected === null && !(posMode() && d.spin);
}

function moveTo(fromIdx, toIdx) {
  if (act({ t: 'move', f: fromIdx, to: toIdx })) S.draft.moving = null;
  render();
}

function startSpin(isReroll = false) {
  const d = S.draft;
  if (d.spinning || !openSlots().length) return;
  if (posMode() && d.target === null) { toast('Pick an open position first'); return; }
  if (isReroll && d.rerolls <= 0) return;
  d.selected = null;
  d.moving = null;
  if (!act({ t: isReroll ? 'reroll' : 'spin' })) return;
  d.spinning = true;
  render();
  animateReel(() => {
    d.spinning = false;
    render();
  });
}

function animateReel(done) {
  const teamEl = document.getElementById('reel-team');
  const yearEl = document.getElementById('reel-year');
  const all = teamSeasons(D.eraOf(S.draft.settings));
  // Timers rather than requestAnimationFrame so the spin still resolves in a background tab.
  const start = Date.now();
  const duration = 1500;
  const tick = () => {
    const t = (Date.now() - start) / duration;
    if (t >= 1) { done(); return; }
    const ts = all[Math.floor(Math.random() * all.length)];
    if (teamEl) { teamEl.textContent = teamName(ts.team, ts.year); teamEl.style.color = teamColor(ts.team); }
    if (yearEl) yearEl.textContent = ts.year;
    setTimeout(tick, 40 + 260 * t * t);
  };
  tick();
}

function place(p, slotIdx) {
  if (act({ t: 'pick', p: p.id, s: slotIdx })) S.draft.selected = null;
  render();
}

async function simulate() {
  const d = S.draft;
  const run = S.run;
  if (S.submitting || !D.isComplete(d)) return;
  if (run.runId && !store.get('nickname', null) && !store.get('nicknameAsked', false)) {
    openNicknameModal('nickname-sim');
    return;
  }
  let seasonSeed = randomSeed();
  let server = null;
  if (run.runId) {
    S.submitting = true;
    render();
    try {
      server = await api(`/runs/${run.runId}/submit`, { method: 'POST', body: { playerId: playerId(), actions: d.actions }, timeout: 15000 });
      seasonSeed = server.seasonSeed;
    } catch (e) {
      run.note = e.status === 422 ? 'rejected' : 'offline';
      toast(`${e.message} Playing this season unranked.`);
    }
    S.submitting = false;
  }
  const result = D.runSeason(d, seasonSeed);
  if (server && JSON.stringify(D.summarize(result)) !== JSON.stringify(server.summary)) {
    console.warn('Local replay differs from the server result', D.summarize(result), server.summary);
  }
  S.result = { ...result, server };
  S.opponents = result.opponents;
  S.top3.at = 0;
  const r = S.result;
  const best = store.get('best', null);
  const score = r.wins * 10 + (r.champion ? 5 : 0);
  if (!best || score > best.score) store.set('best', { score, wins: r.wins, losses: r.losses, finish: r.finish });
  store.set('seasons', store.get('seasons', 0) + 1);
  if (r.perfectLeague) store.set('perfect', store.get('perfect', 0) + 1);
  startPlayback();
}

// ---------- Nickname ----------

const NAME_IDEAS = ['Cover Drive', 'Yorker King', 'Helicopter Shot', 'Doosra', 'Super Over', 'Googly', 'Paddle Scoop', 'Death Overs', 'Free Hit', 'Slower Ball'];

function openNicknameModal(mode) {
  S.modal = mode;
  S.modalError = null;
  render();
  requestAnimationFrame(() => {
    const input = document.getElementById('nick-input');
    if (input) { input.focus(); input.select(); }
  });
}

async function saveNickname() {
  const input = document.getElementById('nick-input');
  const name = (input?.value || '').trim();
  try {
    const res = await api(`/players/${playerId()}`, { method: 'PUT', body: { nickname: name } });
    store.set('nickname', res.nickname);
    const mode = S.modal;
    S.modal = null;
    if (mode === 'nickname-sim') simulate();
    else { toast(`You're now ${res.nickname}`); refreshBoards(); render(); }
  } catch (e) {
    S.modalError = e.message;
    render();
    requestAnimationFrame(() => {
      const el = document.getElementById('nick-input');
      if (el) { el.value = name; el.focus(); }
    });
  }
}

function skipNickname() {
  store.set('nicknameAsked', true);
  const mode = S.modal;
  S.modal = null;
  if (mode === 'nickname-sim') simulate(); else render();
}

function renderModal() {
  if (!S.modal) return '';
  const current = store.get('nickname', null);
  const idea = `${NAME_IDEAS[Math.floor(Math.random() * NAME_IDEAS.length)]} ${10 + Math.floor(Math.random() * 90)}`;
  const forSim = S.modal === 'nickname-sim';
  return `
  <div class="modal-backdrop">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="nick-title">
      <h2 id="nick-title">${forSim ? 'Pick a leaderboard name' : 'Change your name'}</h2>
      <p class="muted">${forSim ? 'Your season is ranked against everyone else. This name appears next to your runs.' : 'This updates the name on all your runs.'}</p>
      <input id="nick-input" class="input" maxlength="20" autocomplete="off" value="${esc(current || idea)}">
      ${S.modalError ? `<p class="form-error">${esc(S.modalError)}</p>` : '<p class="hint">3–20 characters: letters, numbers, spaces, _ or -</p>'}
      <div class="modal-actions">
        <button class="btn" data-action="save-nickname">Save${forSim ? ' & simulate' : ''}</button>
        <button class="btn btn-ghost" data-action="skip-nickname">${forSim ? 'Stay anonymous' : 'Cancel'}</button>
      </div>
    </div>
  </div>`;
}

// ---------- Leaderboard data ----------

async function loadLeaderboard() {
  const lb = S.lb;
  lb.status = 'loading';
  render();
  const q = new URLSearchParams({ period: lb.period, difficulty: lb.difficulty, era: lb.era, playerId: playerId() });
  try {
    lb.data = await api(`/leaderboard?${q}`);
    lb.status = 'ok';
  } catch (e) {
    lb.status = 'error';
    lb.error = e.message;
  }
  if (S.screen === 'leaderboard') render();
}

async function toggleRun(runId) {
  const lb = S.lb;
  lb.open = lb.open === runId ? null : runId;
  render();
  if (lb.open && !lb.details[runId]) {
    try { lb.details[runId] = await api(`/runs/${runId}`); } catch (e) { lb.details[runId] = { error: e.message }; }
    if (S.screen === 'leaderboard') render();
  }
}

async function loadMyRuns() {
  S.mine.status = 'loading';
  render();
  try {
    S.mine.data = await api(`/players/${playerId()}/runs`);
    S.mine.status = 'ok';
    if (S.mine.data.nickname) store.set('nickname', S.mine.data.nickname);
  } catch (e) {
    S.mine.status = 'error';
    S.mine.error = e.message;
  }
  if (S.screen === 'myruns') render();
}

async function loadTop3() {
  if (!API_BASE || S.top3.status === 'loading' || Date.now() - S.top3.at < 60000) return;
  S.top3.status = 'loading';
  try {
    S.top3.data = await api('/leaderboard?period=day&difficulty=normal&limit=3');
    S.top3.status = 'ok';
  } catch {
    S.top3.status = 'error';
  }
  S.top3.at = Date.now();
  if (S.screen === 'home') render();
}

function refreshBoards() {
  if (S.screen === 'leaderboard') loadLeaderboard();
  if (S.screen === 'myruns') loadMyRuns();
}

// ---------- Small render helpers ----------

const kindOf = type => SLOTS[type].kind;

function ratingBadge(value, kind, size = '') {
  return `<span class="rating ${size} k-${kind}">${ratingsVisible() ? value : '?'}</span>`;
}

function roleKind(p) {
  return { AR: 'ar', WK: 'wk', BOWL: 'bowl', BAT: 'bat' }[p.role];
}

function roleChips(p) {
  return p.slots.map(s => `<span class="chip k-${kindOf(s)}">${SLOTS[s].short}</span>`).join('');
}

function bar(label, value, max = 99, min = 55) {
  const pct = Math.max(4, Math.min(100, ((value - min) / (max - min)) * 100));
  return `
    <div class="meter">
      <div class="meter-top"><span>${label}</span><b>${ratingsVisible() ? value.toFixed(1) : '—'}</b></div>
      <div class="meter-track"><div class="meter-fill" style="width:${ratingsVisible() ? pct : 0}%"></div></div>
    </div>`;
}

function optionGroup(key, options, cols = options.length) {
  return `<div class="options" style="--cols:${cols}">${options.map(o => `
    <button class="option ${S.settings[key] === o.value ? 'active' : ''}" data-set="${key}" data-value="${o.value}">
      <span class="option-title">${o.title}</span>${o.sub ? `<span class="option-sub">${o.sub}</span>` : ''}
    </button>`).join('')}</div>`;
}

// ---------- Screens ----------

function renderHome() {
  const best = store.get('best', null);
  const seasons = store.get('seasons', 0);
  const perfect = store.get('perfect', 0);
  return `
  <section class="hero">
    <div class="hero-badge">🏏 IPL edition · 2008–${LAST_SEASON}</div>
    <h1 class="hero-title">14<span>-</span>0</h1>
    <p class="hero-sub">Build an All-Time IPL XI</p>
    <div class="hero-cta">
      <button class="btn btn-big" data-action="setup">Play 14-0 →</button>
      <button class="btn btn-ghost" data-action="leaderboard">🏆 Leaderboard</button>
    </div>
    ${API_BASE && S.top3.data?.rows?.length ? `
    <div class="top3">
      <div class="label">Today's top runs · Normal</div>
      ${S.top3.data.rows.map(r => `<div class="top3-row"><span class="t3-rank">${['🥇', '🥈', '🥉'][r.rank - 1]}</span><b>${esc(r.nickname)}</b><span class="t3-rec">${r.wins}-${r.losses}</span><small>${esc(r.finish)}</small></div>`).join('')}
    </div>` : ''}
    ${seasons ? `<div class="record-strip">
      <div><b>${seasons}</b><span>Seasons played</span></div>
      <div><b>${best ? `${best.wins}-${best.losses}` : '—'}</b><span>Best record</span></div>
      <div><b>${perfect}</b><span>Perfect 14-0s</span></div>
    </div>` : ''}
  </section>

  <section class="stats-row">
    <div><b>${STATS.franchises}</b><span>Franchises</span></div>
    <div><b>${STATS.players}</b><span>Players</span></div>
    <div><b>${STATS.squads}</b><span>Squads</span></div>
    <div><b>${LAST_SEASON - FIRST_SEASON + 1}</b><span>Seasons</span></div>
  </section>

  <section class="how" id="how">
    <h2>How to play</h2>
    <ol class="steps">
      <li><span>1</span><div><b>Spin the wheel</b><p>Each spin lands on a real IPL franchise from a specific season, from the 2008 Deccan Chargers to the 2025 Punjab Kings.</p></div></li>
      <li><span>2</span><div><b>Draft a player</b><p>Pick one player from that squad and slot them into your batting order or bowling attack.</p></div></li>
      <li><span>3</span><div><b>Build your XI</b><p>Fill every spot, plus an Impact Player. You can't have more than ${MAX_OVERSEAS} overseas players, same as the real IPL.</p></div></li>
      <li><span>4</span><div><b>Simulate the season</b><p>Play all ${LEAGUE_GAMES} league games, then the playoffs. Win every one to go 14-0.</p></div></li>
    </ol>
    <div class="challenges">
      <h3>Popular challenges</h3>
      <ul>
        <li>Go a full 14-game league stage unbeaten</li>
        <li>Win all 16 games: a perfect 14-0 plus Qualifier 1 and the Final</li>
        <li>Win the title with a 2008–12 era XI</li>
        <li>Win it on Hard mode with ratings hidden</li>
        <li>Lift the trophy with zero overseas players</li>
      </ul>
    </div>
  </section>`;
}

function renderSetup() {
  const c = combo();
  return `
  <section class="setup">
    <h1 class="page-title">14<span>-</span>0</h1>
    <p class="page-sub">Draft your greatest all-time IPL XI</p>

    <h3 class="label">Team combination</h3>
    <div class="options combos">${COMBOS.map(x => `
      <button class="option ${x.id === c.id ? 'active' : ''}" data-set="combo" data-value="${x.id}">
        <span class="option-title">${x.name}</span>
      </button>`).join('')}</div>
    <p class="hint">${esc(c.desc)}</p>
    <div class="lineup-preview">
      ${c.slots.map((t, i) => `<div class="lp-slot k-${kindOf(t)}"><span>${i + 1}</span>${SLOTS[t].short}</div>`).join('')}
      ${S.settings.impact ? `<div class="lp-slot k-imp"><span>+</span>IMP</div>` : ''}
    </div>

    <h3 class="label">Difficulty</h3>
    ${optionGroup('difficulty', Object.entries(DIFFICULTY).map(([value, d]) => ({ value, title: d.name, sub: d.note })))}

    ${S.settings.difficulty !== 'hard' ? `
    <h3 class="label">Show ratings</h3>
    ${optionGroup('showRatings', [
      { value: true, title: 'On', sub: 'Player ratings visible' },
      { value: false, title: 'Off', sub: 'Blind mode: trust your gut' },
    ])}` : ''}

    <h3 class="label">Draft mode</h3>
    ${optionGroup('draftMode', [
      { value: 'squad', title: 'Squad First', sub: 'Spin a squad, pick any player, choose their spot' },
      { value: 'position', title: 'Position First', sub: 'Pick a spot, then spin for a squad to fill it' },
    ])}

    <h3 class="label">Player ratings</h3>
    ${optionGroup('ratingMode', [
      { value: 'season', title: 'Season', sub: 'Rated as they were that exact season' },
      { value: 'prime', title: 'Prime', sub: 'Every player at their career best' },
    ])}

    <h3 class="label">Era</h3>
    ${optionGroup('era', ERAS.map(e => ({ value: e.id, title: e.name })), 5)}
    <p class="hint">Only squads from this range can be spun, and your opponents come from it too.</p>

    <h3 class="label">IPL rules</h3>
    ${optionGroup('impact', [
      { value: true, title: 'Impact Player on', sub: 'Draft a 12th player to sub in' },
      { value: false, title: 'Impact Player off', sub: 'Classic XI only' },
    ])}
    <div style="height:10px"></div>
    ${optionGroup('overseasCap', [
      { value: true, title: `Max ${MAX_OVERSEAS} overseas`, sub: 'The real IPL rule' },
      { value: false, title: 'No limit', sub: 'Stack the overseas stars' },
    ])}

    <button class="btn btn-big btn-block" data-action="start" ${S.starting ? 'disabled' : ''}>${S.starting ? 'Starting…' : 'Start Draft →'}</button>
    ${API_BASE ? `<p class="hint center">${S.settings.overseasCap ? 'Ranked run: your season goes on the leaderboard.' : 'Unranked: the leaderboard only counts runs with the overseas limit on.'}</p>` : ''}
  </section>`;
}

function renderTeamSheet() {
  const d = S.draft;
  const posMode = S.draft.settings.draftMode === 'position';
  const sel = d.selected !== null ? PLAYERS[d.selected] : null;
  const selSlots = sel && d.spin ? slotsFor(sel).map(s => s.idx) : [];
  const moveSlots = d.moving !== null ? moveTargets(d.moving) : [];
  const movable = canMove();
  const ps = picks();
  const avg = ps.length ? ps.reduce((a, pk) => a + pk.ovr, 0) / ps.length : 0;
  const bowlOpts = ps.filter(pk => pk.r.bowl >= 60).length;

  let batNo = 0;
  const rows = d.slots.map(s => {
    const isImp = s.type === 'IMP';
    const num = isImp ? 'IMP' : ++batNo;
    const kind = kindOf(s.type);
    const isMoveTarget = moveSlots.includes(s.idx);
    const clickable = d.moving !== null
      ? isMoveTarget || s.idx === d.moving
      : (!s.pick && posMode && !d.spin && !d.spinning) || selSlots.includes(s.idx) || (s.pick && movable);
    const cls = ['sheet-row', `k-${kind}`, s.pick ? 'filled' : 'empty',
      d.target === s.idx && d.moving === null ? 'targeted' : '',
      selSlots.includes(s.idx) || isMoveTarget ? 'placeable' : '',
      d.moving === s.idx ? 'moving' : '',
      clickable ? 'clickable' : ''].join(' ');
    const body = s.pick
      ? `<div class="sr-main"><b>${esc(s.pick.p.name)}</b>
           <small><span style="color:${teamColor(s.pick.team)}">${seasonTag(s.pick.team, s.pick.year)}</span>${s.pick.p.overseas ? '<span class="os" title="Overseas">✈ Overseas</span>' : ''}</small></div>
         ${ratingBadge(s.pick.ovr, roleKind(s.pick.p), 'sm')}`
      : `<div class="sr-main"><span class="muted">${SLOTS[s.type].label}</span></div>`;
    return `${isImp ? '<div class="sheet-divider">Impact Player</div>' : ''}
      <div class="${cls}" ${clickable ? `data-slot="${s.idx}" role="button" tabindex="0"` : ''}>
        <span class="sr-num">${num}</span>
        <span class="chip k-${kind}">${SLOTS[s.type].short}</span>
        ${body}
      </div>`;
  }).join('');

  return `
  <aside class="sheet">
    <div class="sheet-head">
      <div><div class="label">Combination</div><b>${esc(combo().name)}</b></div>
      <div class="sheet-meta">
        <span title="Rerolls left">↻ ${d.rerolls}</span>
        ${S.settings.overseasCap ? `<span title="Overseas players">✈ ${overseasCount()}/${MAX_OVERSEAS}</span>` : ''}
      </div>
    </div>
    ${d.moving !== null
      ? `<div class="move-hint">Moving <b>${esc(d.slots[d.moving].pick.p.name)}</b>. ${moveSlots.length
          ? 'Tap a highlighted spot to move or swap.' : 'No other spot they can play.'} Tap them again to cancel.</div>`
      : ps.length && movable ? '<div class="move-hint subtle">Tap a drafted player to move them to another spot they can play.</div>' : ''}
    <div class="sheet-rows">${rows}</div>
    <div class="sheet-foot">
      <div><span>Avg rating</span><b>${ps.length && ratingsVisible() ? avg.toFixed(1) : '—'}</b></div>
      <div><span>Bowling options</span><b class="${ps.length === d.slots.length && bowlOpts < 5 ? 'warn' : ''}">${bowlOpts}</b></div>
      <div><span>Picked</span><b>${ps.length}/${d.slots.length}</b></div>
    </div>
    <div class="legend">
      <span class="k-bat">Batter</span><span class="k-wk">Keeper</span><span class="k-ar">All-rounder</span><span class="k-bowl">Bowler</span><span class="k-imp">Impact</span>
    </div>
  </aside>`;
}

function renderSquad() {
  const d = S.draft;
  const { team, year } = d.spin;
  const posMode = S.draft.settings.draftMode === 'position';
  let list = squad(team, year).map(p => {
    const r = ratingsFor(p, year, S.settings.ratingMode);
    return { p, r, ovr: overall(p, r), block: blockReason(p) };
  });
  const sorters = {
    rating: (a, b) => b.ovr - a.ovr,
    role: (a, b) => 'BAT WK AR BOWL'.indexOf(a.p.role) - 'BAT WK AR BOWL'.indexOf(b.p.role) || b.ovr - a.ovr,
    name: (a, b) => a.p.name.split(' ').at(-1).localeCompare(b.p.name.split(' ').at(-1)),
  };
  if (!ratingsVisible() && d.sort === 'rating') list = shuffle(list).sort((a, b) => !!a.block - !!b.block);
  else list.sort(sorters[d.sort]);

  const target = posMode && d.target !== null ? d.slots[d.target] : null;
  return `
  <div class="squad-head" style="--team:${teamColor(team)}">
    <div>
      <div class="label">Squad spun <span class="pill">${S.settings.ratingMode === 'prime' ? 'Prime' : 'Season'}</span> <span class="muted">${openSlots().length} spots left</span></div>
      <h2><span class="dot"></span>${esc(teamName(team, year))} <span class="year">${year}</span></h2>
    </div>
    <button class="btn btn-outline" data-action="reroll" ${d.rerolls > 0 ? '' : 'disabled'}>↻ Re-roll (${d.rerolls} left)</button>
  </div>
  <p class="hint">${target ? `Filling <b>${SLOTS[target.type].label}</b>. Tap a player to slot them in.` : 'Pick any player, then choose which open spot to put them in.'}</p>
  ${ratingsVisible() ? `<div class="sort">Sort ${['rating', 'role', 'name'].map(k => `<button class="${d.sort === k ? 'active' : ''}" data-sort="${k}">${{ rating: 'Rating ↓', role: 'Role', name: 'Surname A–Z' }[k]}</button>`).join('')}</div>` : ''}
  <div class="players">
    ${list.map(({ p, ovr, block }) => {
      const open = d.selected === p.id && !block;
      const slots = open ? slotsFor(p) : [];
      return `
      <div class="player ${block ? 'blocked' : ''} ${open ? 'open' : ''}" data-player="${p.id}" role="button" tabindex="0">
        <div class="player-row">
          ${ratingBadge(ovr, roleKind(p))}
          <div class="player-main">
            <b>${esc(p.name)}</b>
            <small>${p.overseas ? `✈ ${esc(p.country)} · Overseas` : 'India'}${block ? ` · <em>${block}</em>` : ''}</small>
          </div>
          <div class="chips">${roleChips(p)}</div>
        </div>
        ${open ? `<div class="place">
          <div class="label">Place in (${slots.length})</div>
          <div class="place-btns">${slots.map(s => `<button class="btn btn-place k-${kindOf(s.type)}" data-place="${s.idx}">${SLOTS[s.type].label}${s.type === 'IMP' ? '' : ` · #${d.slots.filter(x => x.type !== 'IMP').indexOf(s) + 1}`}</button>`).join('')}</div>
        </div>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

function renderReady() {
  const u = userTeam();
  const warn = u.bowlingOptions < 5 ? `<p class="warnbox">Heads up: only ${u.bowlingOptions} genuine bowling options. Part-timers will have to bowl the rest.</p>` : '';
  return `
  <div class="ready">
    <div class="label">Squad complete</div>
    <h2>Your XI is ready</h2>
    ${bar('Batting', u.bat)}
    ${bar('Bowling', u.bowl)}
    ${bar('Team rating', u.ovr)}
    ${warn}
    <button class="btn btn-big btn-block" data-action="simulate" ${S.submitting ? 'disabled' : ''}>${S.submitting ? 'Submitting your XI…' : 'Simulate season →'}</button>
    ${S.run?.runId ? `<p class="hint center">${S.run.ranked ? '🏅 Ranked run' : esc(UNRANKED_NOTES[S.run.note] || '')}</p>` : S.run?.note ? `<p class="hint center">${esc(UNRANKED_NOTES[S.run.note])}</p>` : ''}
  </div>`;
}

function renderDraft() {
  const d = S.draft;
  const left = openSlots().length;
  const posMode = S.draft.settings.draftMode === 'position';
  let panel;
  if (!left) panel = renderReady();
  else if (squadShown()) panel = renderSquad();
  else {
    const target = posMode && d.target !== null ? d.slots[d.target] : null;
    panel = `
    <div class="spin-panel">
      <div class="label">${posMode ? (target ? `Spin for a ${SLOTS[target.type].label}` : 'Pick a position') : 'Spin for a squad'}</div>
      <p class="muted">${left} spot${left === 1 ? '' : 's'} left to fill</p>
      ${posMode && !target ? `<p class="hint">Tap an empty spot on your team sheet to choose what to fill next.</p>` : ''}
      <div class="reel ${d.spinning ? 'spinning' : ''}">
        <div class="reel-box"><div class="label">Franchise</div><div id="reel-team" class="reel-val">${d.spinning ? '…' : '—'}</div></div>
        <div class="reel-box small"><div class="label">Season</div><div id="reel-year" class="reel-val">${d.spinning ? '…' : '—'}</div></div>
      </div>
      <button class="btn btn-big" data-action="spin" ${d.spinning || (posMode && !target) ? 'disabled' : ''}>🎰 Spin the Wheel</button>
      <p class="muted tiny">or press Space</p>
    </div>`;
  }

  return `
  <section class="draft">
    ${renderTeamSheet()}
    <div class="panel">${panel}
      <div class="panel-foot"><button class="btn btn-ghost btn-small" data-action="restart">↺ Restart run</button></div>
    </div>
  </section>`;
}

function inningsText(inn, label) {
  return `<span class="inn"><b>${esc(label)}</b> ${inn.runs}/${inn.wkts}${inn.wkts === 10 ? '' : ''} <small>(${overs(inn.balls)})</small></span>`;
}

function matchRow(m, i) {
  const userFirst = m.battedFirst;
  const a = userFirst ? inningsText(m.userInn, 'You') : inningsText(m.oppInn, m.opp.short);
  const b = userFirst ? inningsText(m.oppInn, m.opp.short) : inningsText(m.userInn, 'You');
  const verdict = m.won ? `Won by ${m.margin}` : `Lost by ${m.margin}`;
  return `
  <div class="match ${m.won ? 'w' : 'l'}" style="animation-delay:${Math.min(i, 20) * 45}ms">
    <div class="m-num">${m.stage === 'League' ? `M${i + 1}` : esc(m.stage.replace('Qualifier ', 'Q').replace('Eliminator', 'ELIM').replace('Final', 'FINAL'))}</div>
    <div class="m-res">${m.won ? 'W' : 'L'}</div>
    <div class="m-body">
      <div class="m-top"><span>vs <b style="color:${m.opp.color}">${esc(m.opp.name)}</b></span><span class="m-verdict">${verdict}</span></div>
      <div class="m-score">${a}<span class="vs">·</span>${b}</div>
      <div class="m-stars">⭐ ${esc(m.topBat.name)} ${m.topBat.runs} (${m.topBat.balls}) · 🎯 ${esc(m.topBowl.name)} ${m.topBowl.wkts}/${m.topBowl.runs}</div>
    </div>
  </div>`;
}

function verdictFor(r) {
  if (r.perfectSeason) return { title: 'PERFECT SEASON', text: 'Won every game, playoffs included. That is the impossible run.', cls: 'gold' };
  if (r.perfectLeague && r.champion) return { title: '14-0 & CHAMPIONS', text: 'Unbeaten in the league and lifted the trophy.', cls: 'gold' };
  if (r.perfectLeague) return { title: '14-0… BUT', text: 'An unbeaten league stage, then the playoffs got you. That\'s the IPL.', cls: 'silver' };
  if (r.champion) return { title: 'CHAMPIONS', text: `Took the title after a ${r.wins}-${r.losses} league stage.`, cls: 'gold' };
  if (r.finish === 'Runners-up') return { title: 'RUNNERS-UP', text: 'So close. Fell at the final hurdle.', cls: 'silver' };
  if (r.position <= 4) return { title: 'PLAYOFF EXIT', text: `${r.finish} after finishing ${ordinal(r.position)} in the league.`, cls: 'bronze' };
  return { title: 'NO PLAYOFFS', text: `Finished ${ordinal(r.position)} in the table. Back to the auction table.`, cls: 'plain' };
}

function renderSeason() {
  const r = S.result;
  const v = verdictFor(r);
  const league = r.log.filter(m => m.stage === 'League');
  const playoffLog = r.log.filter(m => m.stage !== 'League');

  const table = r.rows.map((row, i) => `
    <tr class="${row.id === 'YOU' ? 'you' : ''} ${i === 3 ? 'cut' : ''}">
      <td>${i + 1}</td>
      <td class="t-name"><span class="dot" style="background:${row.team.color}"></span>${esc(row.id === 'YOU' ? 'Your XI' : row.team.short)}</td>
      <td>${row.p}</td><td>${row.w}</td><td>${row.l}</td>
      <td>${row.nrr >= 0 ? '+' : ''}${row.nrr.toFixed(3)}</td>
      <td><b>${row.pts}</b></td>
    </tr>`).join('');

  const bracket = r.playoffs.map(g => `
    <div class="bracket-game ${g.involved ? 'involved' : ''}">
      <div class="label">${g.label}</div>
      <div class="bg-team ${g.win === g.a ? 'win' : ''}">${esc(g.a.id === 'YOU' ? 'Your XI' : g.a.short)}</div>
      <div class="bg-team ${g.win === g.b ? 'win' : ''}">${esc(g.b.id === 'YOU' ? 'Your XI' : g.b.short)}</div>
      <small>${esc(g.win.id === 'YOU' ? 'Your XI' : g.win.short)} won by ${esc(g.res.margin)}</small>
    </div>`).join('');

  const cap = (icon, title, s, line) => s ? `
    <div class="cap">
      <div class="cap-icon">${icon}</div>
      <div><div class="label">${title}</div><b>${esc(s.p.name)}</b><small>${line}</small></div>
    </div>` : '';

  const xi = S.draft.slots.map(s => s.pick).map((pk, i) => `
    <div class="xi-row">
      <span class="sr-num">${S.draft.slots[i].type === 'IMP' ? 'IMP' : i + 1}</span>
      <b>${esc(pk.p.name)}</b>
      <small style="color:${teamColor(pk.team)}">${seasonTag(pk.team, pk.year)}</small>
      ${ratingBadge(pk.ovr, roleKind(pk.p), 'sm')}
    </div>`).join('');

  return `
  <section class="season">
    <div class="result-hero ${v.cls}">
      <div class="label">League stage</div>
      <div class="big-record">${r.wins}<span>-</span>${r.losses}</div>
      <div class="verdict">${v.title}</div>
      <p>${v.text}</p>
      <div class="dots">${league.map(m => `<span class="${m.won ? 'w' : 'l'}" title="vs ${esc(m.opp.name)}"></span>`).join('')}</div>
      ${rankBanner(r)}
      <div class="hero-actions">
        <button class="btn" data-action="share">Share result</button>
        ${API_BASE ? '<button class="btn btn-outline" data-action="leaderboard">🏆 Leaderboard</button>' : ''}
        <button class="btn btn-ghost" data-action="setup">New draft</button>
      </div>
    </div>

    <div class="caps">
      ${cap('🟠', 'Orange Cap', r.orange, `${r.orange.runs} runs · HS ${r.orange.hs} · SR ${(r.orange.runs * 100 / Math.max(1, r.orange.balls)).toFixed(0)}`)}
      ${cap('🟣', 'Purple Cap', r.purple, `${r.purple.wkts} wickets · Best ${r.purple.best ? `${r.purple.best.w}/${r.purple.best.r}` : '—'}`)}
      ${cap('🏅', 'Player of the Season', r.mvp, `${r.mvp.runs} runs · ${r.mvp.wkts} wickets`)}
    </div>

    <div class="season-grid">
      <div class="card">
        <h3>Points table</h3>
        <table class="table">
          <thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>L</th><th>NRR</th><th>Pts</th></tr></thead>
          <tbody>${table}</tbody>
        </table>
        <h3 class="mt">Playoffs</h3>
        <div class="bracket">${bracket}</div>
        <p class="hint">Champions: <b>${esc(r.champion_team.id === 'YOU' ? 'Your XI 🏆' : r.champion_team.name)}</b></p>
      </div>
      <div class="card">
        <h3>Your matches</h3>
        <div class="matches">
          ${league.map(matchRow).join('')}
          ${playoffLog.length ? `<div class="sheet-divider">Playoffs</div>${playoffLog.map((m, i) => matchRow(m, LEAGUE_GAMES + i)).join('')}` : ''}
        </div>
      </div>
    </div>

    <div class="season-grid">
      <div class="card">
        <h3>Your XI</h3>
        <div class="xi">${xi}</div>
      </div>
      <div class="card">
        <h3>Team ratings</h3>
        ${bar('Batting', r.user.bat)}
        ${bar('Bowling', r.user.bowl)}
        ${bar('Team rating', r.user.ovr)}
        <h3 class="mt">Opponents</h3>
        <div class="opps">${S.opponents.map(o => `
          <div class="opp"><span class="dot" style="background:${o.color}"></span><b>${esc(o.name)}</b>
          <small>${o.stars.map(esc).join(', ')}</small>${ratingsVisible() ? `<span class="opp-r">${o.ovr.toFixed(1)}</span>` : ''}</div>`).join('')}
        </div>
      </div>
    </div>
  </section>`;
}

// ---------- Live season playback ----------
// The season is already decided; playback just reveals it as a list of timed frames.

let L = null;
const SPEEDS = [1, 2, 4];
const shortName = t => (t.id === 'YOU' ? 'Your XI' : t.short);

function buildFrames(r) {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const ticks = reduce ? 0 : 6;
  const frames = [];
  const playOut = (base, m, tickMs, resultMs, done) => {
    for (const step of ['inn1', 'inn2']) {
      for (let k = 1; k <= ticks; k++) frames.push({ ...base, m, step, part: k / ticks, dur: tickMs });
    }
    frames.push({ ...base, ...done, m, step: 'result', dur: resultMs });
  };

  r.log.filter(m => m.stage === 'League').forEach((m, i) => {
    playOut({ phase: 'league', round: i, revealed: i }, m, 130, 1100, { revealed: i + 1 });
  });
  const qualified = r.position <= 4;
  frames.push({ phase: 'leagueEnd', revealed: LEAGUE_GAMES, dur: 2200 });
  r.playoffs.forEach((g, gi) => {
    const base = { phase: 'playoffs', revealed: LEAGUE_GAMES, po: gi, poDone: gi };
    frames.push({ ...base, poStep: 'intro', dur: qualified ? 1400 : 600 });
    if (g.involved) playOut(base, r.log.find(m => m.stage === g.label), 170, 1800, { poDone: gi + 1 });
    else frames.push({ ...base, poStep: 'result', poDone: gi + 1, dur: qualified ? 1500 : 800 });
  });
  frames.push({ phase: 'champion', revealed: LEAGUE_GAMES, poDone: r.playoffs.length, dur: 3000 });
  return frames;
}

const speed = () => (SPEEDS.includes(S.settings.playSpeed) ? S.settings.playSpeed : 1);

function startPlayback() {
  stopPlayback();
  L = { frames: buildFrames(S.result), i: 0, timer: null, paused: false };
  go('live');
  schedule();
}

function stopPlayback() {
  if (L) clearTimeout(L.timer);
  L = null;
}

function schedule() {
  clearTimeout(L.timer);
  if (L.paused) return;
  L.timer = setTimeout(() => {
    if (L.i >= L.frames.length - 1) { finishPlayback(); return; }
    L.i++;
    render();
    schedule();
  }, L.frames[L.i].dur / speed());
}

function jumpTo(i) {
  L.i = Math.max(0, Math.min(i, L.frames.length - 1));
  render();
  schedule();
}

function finishPlayback() { go('season'); }
function togglePause() { L.paused = !L.paused; render(); schedule(); }
function setSpeed() {
  S.settings.playSpeed = SPEEDS[(SPEEDS.indexOf(speed()) + 1) % SPEEDS.length];
  store.set('settings', S.settings);
  render();
  schedule();
}
function skipToPlayoffs() { jumpTo(L.frames.findIndex(f => f.phase !== 'league')); }
function nextResult() {
  const j = L.frames.findIndex((f, k) => k > L.i && (f.step === 'result' || f.poStep || f.phase === 'leagueEnd' || f.phase === 'champion'));
  if (j === -1) finishPlayback(); else jumpTo(j);
}

function partial(inn, part) {
  if (part >= 1) return inn;
  return { runs: Math.round(inn.runs * part), wkts: Math.floor(inn.wkts * part), balls: Math.round(inn.balls * part) };
}

function liveMatchCard(f) {
  const m = f.m;
  const [inn1, inn2] = m.battedFirst ? [m.userInn, m.oppInn] : [m.oppInn, m.userInn];
  const [name1, name2] = m.battedFirst ? ['Your XI', m.opp.short] : [m.opp.short, 'Your XI'];
  const p1 = f.step === 'inn1' ? partial(inn1, f.part) : inn1;
  const p2 = f.step === 'inn2' ? partial(inn2, f.part) : f.step === 'result' ? inn2 : null;
  const line = (name, inn, batting) => `
    <div class="lm-team ${batting ? 'batting' : ''}">
      <span>${esc(name)}${batting ? ' <i class="bat-dot"></i>' : ''}</span>
      <b>${inn ? `${inn.runs}/${inn.wkts} <small>(${overs(inn.balls)})</small>` : '<small>Yet to bat</small>'}</b>
    </div>`;
  let status;
  if (f.step === 'inn1') status = `${esc(name1)} batting`;
  else if (f.step === 'inn2') {
    const need = inn1.runs + 1 - p2.runs, left = 120 - p2.balls;
    status = need > 0 ? `${esc(name2)} need ${need} from ${left} ball${left === 1 ? '' : 's'}` : `${esc(name2)} batting`;
  } else status = `<span class="${m.won ? 'win' : 'loss'}">${m.won ? 'Won' : 'Lost'} by ${esc(m.margin)}</span>`;
  const label = m.stage === 'League' ? `Match ${m.round + 1} of ${LEAGUE_GAMES}` : m.stage;
  return `
  <div class="live-card ${f.step === 'result' ? (m.won ? 'w' : 'l') : 'playing'}">
    <div class="lc-head"><span class="label">${esc(label)}</span>${f.step === 'result' ? '' : '<span class="live-pill">● LIVE</span>'}</div>
    <div class="lc-vs">vs <b style="color:${m.opp.color}">${esc(m.opp.name)}</b></div>
    ${line(name1, p1, f.step === 'inn1')}
    ${line(name2, p2, f.step === 'inn2')}
    <div class="lc-status">${status}</div>
    ${f.step === 'result' ? `<div class="m-stars">⭐ ${esc(m.topBat.name)} ${m.topBat.runs} (${m.topBat.balls}) · 🎯 ${esc(m.topBowl.name)} ${m.topBowl.wkts}/${m.topBowl.runs}</div>` : ''}
  </div>`;
}

function liveInfoCard(f, r) {
  if (f.phase === 'leagueEnd') {
    const row = r.rows.find(x => x.id === 'YOU');
    return `
    <div class="live-card ${r.position <= 4 ? 'w' : 'l'}">
      <div class="lc-head"><span class="label">League stage complete</span></div>
      <div class="lc-big">${ordinal(r.position)}</div>
      <div class="lc-status">${row.pts} points · NRR ${row.nrr >= 0 ? '+' : ''}${row.nrr.toFixed(3)}</div>
      <p class="muted">${r.position <= 4 ? 'Into the playoffs.' : 'Missed the playoffs. Here is how the rest played out.'}</p>
    </div>`;
  }
  if (f.phase === 'champion') {
    const champ = r.champion_team;
    return `
    <div class="live-card ${r.champion ? 'w gold' : ''}">
      <div class="lc-head"><span class="label">Season complete</span></div>
      <div class="lc-big">🏆</div>
      <div class="lc-status">${esc(champ.id === 'YOU' ? 'Your XI are the champions!' : `${champ.name} are the champions`)}</div>
    </div>`;
  }
  const g = r.playoffs[f.po];
  const done = f.poStep === 'result';
  return `
  <div class="live-card ${done ? '' : 'playing'}">
    <div class="lc-head"><span class="label">${esc(g.label)}</span>${done ? '' : '<span class="live-pill">UP NEXT</span>'}</div>
    <div class="lc-vs"><b style="color:${g.a.color}">${esc(shortName(g.a))}</b> vs <b style="color:${g.b.color}">${esc(shortName(g.b))}</b></div>
    <div class="lc-status">${done ? `${esc(shortName(g.win))} won by ${esc(g.res.margin)}` : 'Toss coming up…'}</div>
  </div>`;
}

function renderLive() {
  const r = S.result;
  const f = L.frames[L.i];
  const revealed = f.revealed;
  const league = r.log.filter(m => m.stage === 'League');
  const shown = league.slice(0, revealed);
  const w = shown.filter(m => m.won).length;
  const rows = standings(r.teams, r.matches.filter(m => m.round < revealed));
  const pos = rows.findIndex(x => x.id === 'YOU') + 1;
  const inLeague = f.phase === 'league';

  const title = inLeague ? `Round ${f.round + 1} of ${LEAGUE_GAMES}`
    : f.phase === 'leagueEnd' ? 'League stage complete'
    : f.phase === 'playoffs' ? 'Playoffs' : 'Season complete';

  const table = rows.map((row, i) => `
    <tr class="${row.id === 'YOU' ? 'you' : ''} ${i === 3 ? 'cut' : ''}">
      <td>${i + 1}</td>
      <td class="t-name"><span class="dot" style="background:${row.team.color}"></span>${esc(shortName(row.team))}</td>
      <td>${row.p}</td><td>${row.w}</td><td>${row.l}</td>
      <td>${row.p ? `${row.nrr >= 0 ? '+' : ''}${row.nrr.toFixed(2)}` : '—'}</td>
      <td><b>${row.pts}</b></td>
    </tr>`).join('');

  const lastRound = revealed - 1;
  const byId = Object.fromEntries(r.teams.map(t => [t.id, t]));
  const elsewhere = inLeague && lastRound >= 0 ? `
    <div class="card elsewhere">
      <h3>Elsewhere in round ${lastRound + 1}</h3>
      ${r.matches.filter(m => m.round === lastRound && m.home !== 'YOU' && m.away !== 'YOU').map(m => {
        const win = byId[m.res.winner], lose = byId[m.res.winner === m.home ? m.away : m.home];
        return `<div class="ew-row"><span><b style="color:${win.color}">${esc(win.short)}</b> beat ${esc(lose.short)}</span><small>${esc(m.res.margin)}</small></div>`;
      }).join('')}
    </div>` : '';

  const bracket = !inLeague && f.poDone ? `
    <div class="card">
      <h3>Playoffs</h3>
      <div class="bracket">${r.playoffs.slice(0, f.poDone).map(g => `
        <div class="bracket-game ${g.involved ? 'involved' : ''}">
          <div class="label">${g.label}</div>
          <div class="bg-team ${g.win === g.a ? 'win' : ''}">${esc(shortName(g.a))}</div>
          <div class="bg-team ${g.win === g.b ? 'win' : ''}">${esc(shortName(g.b))}</div>
          <small>won by ${esc(g.res.margin)}</small>
        </div>`).join('')}</div>
    </div>` : '';

  return `
  <section class="live">
    <div class="live-top">
      <div>
        <div class="label">${esc(title)}</div>
        <div class="live-record">${w}<span>-</span>${shown.length - w}</div>
        <div class="dots">${league.map((m, i) => `<span class="${i < revealed ? (m.won ? 'w' : 'l') : 'pending'}"></span>`).join('')}</div>
      </div>
      <div class="live-controls">
        <button class="btn btn-ghost btn-small" data-action="pause">${L.paused ? '▶ Resume' : '❚❚ Pause'}</button>
        <button class="btn btn-ghost btn-small" data-action="speed" title="Playback speed">${speed()}×</button>
        ${inLeague ? '<button class="btn btn-outline btn-small" data-action="skip-playoffs">Skip to playoffs ⏭</button>' : ''}
        <button class="btn btn-small" data-action="skip-end">Skip to end ⏭</button>
      </div>
    </div>
    <div class="live-grid">
      <div class="live-main">
        ${f.m ? liveMatchCard(f) : liveInfoCard(f, r)}
        ${elsewhere}${bracket}
      </div>
      <div class="card">
        <h3>Points table ${revealed ? `<small>· you're ${ordinal(pos)}</small>` : ''}</h3>
        <table class="table">
          <thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>L</th><th>NRR</th><th>Pts</th></tr></thead>
          <tbody>${table}</tbody>
        </table>
      </div>
    </div>
    <p class="muted tiny center">Space to pause · → next result</p>
  </section>`;
}

// ---------- Leaderboard screens ----------

const STAGE_ICON = ['', '', '', '🥈', '🏆'];

function ago(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const signed = n => `${n >= 0 ? '+' : ''}${Number(n).toFixed(3)}`;

function rankBanner(r) {
  if (!API_BASE) return '';
  const srv = r.server;
  if (srv?.ranks) {
    const k = srv.ranks;
    return `<div class="rank-banner">🏅 <b>#${k.day}</b> today · <b>#${k.week}</b> this week · <b>#${k.all}</b> all-time <span class="muted">· ${esc(DIFFICULTY[srv.difficulty].name)}</span></div>`;
  }
  const note = srv && !srv.ranked ? 'nocap' : S.run?.note;
  return note ? `<div class="rank-banner muted">${esc(UNRANKED_NOTES[note])}</div>` : '';
}

function xiChips(xi) {
  return `<div class="xi-chips">${xi.map(x => `
    <span class="xi-chip k-${kindOf(x.slot)}"><b>${SLOTS[x.slot].short}</b> ${esc(x.name)} <small style="color:${teamColor(x.team)}">${seasonTag(x.team, x.year)}</small></span>`).join('')}</div>`;
}

function tagsFor(r) {
  const era = ERAS.find(e => e.id === r.era);
  return [
    r.era !== 'all' && era ? era.name : null,
    r.ratingMode === 'prime' ? 'Prime' : null,
  ].filter(Boolean).map(t => `<span class="tag">${esc(t)}</span>`).join('');
}

function boardRow(r, open, isYou) {
  const detail = open ? S.lb.details[r.runId] : null;
  return `
  <div class="lb-row ${isYou ? 'you' : ''} ${open ? 'open' : ''}" data-run="${r.runId}" role="button" tabindex="0">
    <div class="lb-main">
      <span class="lb-rank ${r.rank <= 3 ? 'top' : ''}">${r.rank}</span>
      <span class="lb-name"><b>${esc(r.nickname)}</b>${isYou ? ' <span class="tag you-tag">You</span>' : ''}${tagsFor(r)}</span>
      <span class="lb-rec">${r.wins}-${r.losses}</span>
      <span class="lb-finish">${STAGE_ICON[r.stage] || ''} ${esc(r.finish)}</span>
      <span class="lb-nrr">${signed(r.nrr)}</span>
      <span class="lb-when">${ago(r.completedAt)}</span>
    </div>
    ${open ? `<div class="lb-detail">${!detail ? '<p class="muted">Loading XI…</p>' : detail.error ? `<p class="form-error">${esc(detail.error)}</p>` : `
      ${xiChips(detail.xi)}
      <p class="hint">Team rating ${detail.teamRating} · Finished ${ordinal(detail.position)} in the league · ${esc(COMBOS.find(c => c.id === detail.settings.combo)?.name || '')}</p>`}
    </div>` : ''}
  </div>`;
}

function renderLeaderboard() {
  const lb = S.lb;
  const nick = store.get('nickname', null);
  if (!API_BASE) {
    return `<section class="board"><h1 class="page-title">Leaderboard</h1>
      <p class="page-sub">The leaderboard isn't live yet. Your runs still count on this device.</p>
      <div class="center"><button class="btn" data-action="setup">Play a run →</button></div></section>`;
  }
  const chip = (key, value, label) => `<button class="${lb[key] === value ? 'active' : ''}" data-lb="${key}:${value}">${label}</button>`;
  const data = lb.data;
  const rows = data?.rows ?? [];
  const you = data?.you;
  const youInTop = you && rows.some(r => r.runId === you.runId);
  let body;
  if (lb.status === 'loading' && !data) body = '<p class="muted center pad">Loading…</p>';
  else if (lb.status === 'error') body = `<p class="form-error center pad">${esc(lb.error)}</p>`;
  else if (!rows.length) body = `<div class="empty"><p>No ranked runs ${lb.period === 'day' ? 'today' : lb.period === 'week' ? 'this week' : 'yet'} on ${DIFFICULTY[lb.difficulty].name}.</p><button class="btn" data-action="setup">Be the first →</button></div>`;
  else body = `
    <div class="lb-head"><span>#</span><span>Player</span><span>Record</span><span>Finish</span><span>NRR</span><span>When</span></div>
    ${rows.map(r => boardRow(r, lb.open === r.runId, you && r.runId === you.runId)).join('')}
    ${you && !youInTop ? `<div class="lb-gap">· · ·</div>${boardRow(you, lb.open === you.runId, true)}` : ''}`;

  return `
  <section class="board">
    <h1 class="page-title">Leaderboard</h1>
    <p class="page-sub">Server-verified seasons only. Ranked by wins, then playoff finish, then NRR.</p>
    <div class="board-controls">
      <div class="seg">${chip('period', 'day', 'Today')}${chip('period', 'week', 'This week')}${chip('period', 'all', 'All-time')}</div>
      <div class="seg">${Object.entries(DIFFICULTY).map(([k, v]) => chip('difficulty', k, v.name)).join('')}</div>
      <div class="seg wrap">${chip('era', 'any', 'Any era')}${ERAS.map(e => chip('era', e.id, e.name)).join('')}</div>
    </div>
    <div class="board-me">
      <span>Playing as <b>${esc(nick || 'Anonymous')}</b></span>
      <button class="link" data-action="edit-nickname">${nick ? 'Change name' : 'Set a name'}</button>
      <button class="link" data-action="myruns">My runs →</button>
      ${data ? `<span class="muted">${data.total} ranked run${data.total === 1 ? '' : 's'}${lb.status === 'loading' ? ' · refreshing…' : ''}</span>` : ''}
    </div>
    <div class="card board-card">${body}</div>
    <p class="hint center">"Today" and "This week" reset at midnight IST (weeks start Monday). Runs with the overseas limit off aren't ranked.</p>
  </section>`;
}

function renderMyRuns() {
  const m = S.mine;
  const nick = store.get('nickname', null);
  if (!API_BASE) return renderLeaderboard();
  let body;
  if (m.status === 'loading' && !m.data) body = '<p class="muted center pad">Loading…</p>';
  else if (m.status === 'error') body = `<p class="form-error center pad">${esc(m.error)}</p>`;
  else if (!m.data?.runs.length) body = '<div class="empty"><p>No completed runs from this device yet.</p><button class="btn" data-action="setup">Play a run →</button></div>';
  else body = m.data.runs.map(r => `
    <div class="lb-row ${m.open === r.runId ? 'open' : ''}" data-myrun="${r.runId}" role="button" tabindex="0">
      <div class="my-main">
        <span class="lb-rec">${r.wins}-${r.losses}</span>
        <span class="lb-finish">${STAGE_ICON[r.stage] || ''} ${esc(r.finish)}</span>
        <span class="my-tags"><span class="tag">${esc(DIFFICULTY[r.difficulty].name)}</span>${tagsFor(r)}${r.ranked ? '' : '<span class="tag">Unranked</span>'}</span>
        <span class="lb-when">${ago(r.completedAt)}</span>
      </div>
      ${m.open === r.runId ? `<div class="lb-detail">${xiChips(r.xi)}<p class="hint">Team rating ${r.teamRating} · NRR ${signed(r.nrr)}</p></div>` : ''}
    </div>`).join('');
  return `
  <section class="board">
    <h1 class="page-title">My runs</h1>
    <p class="page-sub">Playing as <b>${esc(nick || 'Anonymous')}</b> · <button class="link inline" data-action="edit-nickname">${nick ? 'Change name' : 'Set a name'}</button></p>
    <div class="card board-card">${body}</div>
    <div class="center"><button class="btn btn-ghost" data-action="leaderboard">← Leaderboard</button></div>
    <p class="hint center">Runs are tied to this browser. Clearing site data starts you fresh.</p>
  </section>`;
}

function shareText() {
  const r = S.result;
  const league = r.log.filter(m => m.stage === 'League');
  const lines = [
    `🏏 14-0 · All-Time IPL XI`,
    `League: ${r.wins}-${r.losses} (${ordinal(r.position)}) · ${r.finish}${r.champion ? ' 🏆' : ''}`,
    league.map(m => (m.won ? '🟩' : '🟥')).join(''),
    '',
    ...S.draft.slots.map(s => `${s.type === 'IMP' ? 'IMP' : SLOTS[s.type].short}: ${s.pick.p.name} (${seasonTag(s.pick.team, s.pick.year)})`),
    '',
    `Can you go 14-0?`,
  ];
  return lines.join('\n');
}

async function share() {
  const text = shareText();
  try {
    await navigator.clipboard.writeText(text);
    toast('Result copied to clipboard');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Result copied to clipboard'); } catch { toast('Copy failed'); }
    ta.remove();
  }
}

// ---------- Render & events ----------

function render() {
  if (S.screen === 'draft' && !S.draft) S.screen = 'setup';
  if ((S.screen === 'season' || S.screen === 'live') && !S.result) S.screen = 'home';
  if (S.screen === 'live' && !L) S.screen = 'season';
  app.innerHTML = {
    home: renderHome, setup: renderSetup, draft: renderDraft, live: renderLive, season: renderSeason,
    leaderboard: renderLeaderboard, myruns: renderMyRuns,
  }[S.screen]() + renderModal();
  document.body.dataset.screen = S.screen;
}

function handle(el) {
  const d = S.draft;
  if (el.dataset.set) {
    const raw = el.dataset.value;
    S.settings[el.dataset.set] = raw === 'true' ? true : raw === 'false' ? false : raw;
    store.set('settings', S.settings);
    render();
    return;
  }
  if (el.dataset.sort) { d.sort = el.dataset.sort; render(); return; }
  if (el.dataset.lb) {
    const [key, value] = el.dataset.lb.split(':');
    S.lb[key] = value;
    S.lb.open = null;
    loadLeaderboard();
    return;
  }
  if (el.dataset.run) { toggleRun(el.dataset.run); return; }
  if (el.dataset.myrun) { S.mine.open = S.mine.open === el.dataset.myrun ? null : el.dataset.myrun; render(); return; }
  if (el.dataset.place !== undefined) { place(PLAYERS[d.selected], Number(el.dataset.place)); return; }
  if (el.dataset.slot !== undefined) {
    const idx = Number(el.dataset.slot);
    if (d.moving !== null) {
      if (idx === d.moving) { d.moving = null; render(); }
      else if (moveTargets(d.moving).includes(idx)) moveTo(d.moving, idx);
      return;
    }
    if (squadShown() && d.selected !== null) { place(PLAYERS[d.selected], idx); return; }
    if (d.slots[idx].pick) { if (canMove()) { d.moving = idx; render(); } return; }
    if (posMode() && !d.spin) { act({ t: 'target', s: d.target === idx ? null : idx }); render(); }
    return;
  }
  if (el.dataset.player !== undefined) {
    const p = PLAYERS[Number(el.dataset.player)];
    if (blockReason(p)) return;
    d.moving = null;
    if (posMode()) { place(p, slotsFor(p)[0].idx); return; }
    d.selected = d.selected === p.id ? null : p.id;
    render();
    return;
  }
  switch (el.dataset.action) {
    case 'home': go('home'); break;
    case 'how':
      if (S.screen !== 'home') go('home');
      requestAnimationFrame(() => document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' }));
      break;
    case 'setup': go('setup'); break;
    case 'start': startRun(); break;
    case 'spin': startSpin(false); break;
    case 'reroll': startSpin(true); break;
    case 'restart': if (confirm('Restart this run? Your picks will be lost.')) startRun(); break;
    case 'simulate': simulate(); break;
    case 'leaderboard': go('leaderboard'); break;
    case 'myruns': go('myruns'); break;
    case 'edit-nickname': openNicknameModal('nickname-edit'); break;
    case 'save-nickname': saveNickname(); break;
    case 'skip-nickname': skipNickname(); break;
    case 'share': share(); break;
    case 'pause': togglePause(); break;
    case 'speed': setSpeed(); break;
    case 'skip-playoffs': skipToPlayoffs(); break;
    case 'skip-end': finishPlayback(); break;
  }
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action],[data-set],[data-sort],[data-place],[data-slot],[data-player],[data-lb],[data-run],[data-myrun]');
  if (!el || el.disabled) return;
  if (el.tagName === 'A') e.preventDefault();
  // A click on a place button inside a player card shouldn't also toggle the card.
  e.stopPropagation();
  handle(el);
});

document.addEventListener('keydown', e => {
  if (S.modal) {
    if (e.key === 'Enter' && e.target.id === 'nick-input') { e.preventDefault(); saveNickname(); }
    else if (e.key === 'Escape') skipNickname();
    return;
  }
  if (e.key === 'Enter' && e.target.matches('[role="button"]')) { handle(e.target); return; }
  if (S.screen === 'live' && L) {
    if (e.code === 'Space') { e.preventDefault(); togglePause(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nextResult(); }
    return;
  }
  if (e.code !== 'Space' || S.screen !== 'draft') return;
  const d = S.draft;
  if (d.spin || d.spinning || !openSlots().length) return;
  if (e.target.matches('input, textarea, button')) return;
  e.preventDefault();
  startSpin(false);
});

render();
loadTop3();
