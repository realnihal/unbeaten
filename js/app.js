import {
  SLOTS, COMBOS, ERAS, MAX_OVERSEAS, LEAGUE_GAMES, PLAYERS, STATS,
  squad, teamSeasons, teamName, teamShort, teamColor, seasonTag,
  ratingsFor, overall, teamStrength, buildOpponents, simulateSeason, overs, ordinal, shuffle,
} from './engine.js';
import { FIRST_SEASON, LAST_SEASON } from './data.js';

const DIFFICULTY = {
  easy:   { name: 'Easy', rerolls: 3, note: '3 rerolls available' },
  normal: { name: 'Normal', rerolls: 1, note: '1 reroll available' },
  hard:   { name: 'Hard', rerolls: 0, note: 'No rerolls · ratings hidden' },
};

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
    ratingMode: 'season', era: 'all', impact: true, overseasCap: true,
    ...store.get('settings', {}),
  },
  draft: null,
  result: null,
  opponents: null,
};

const app = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ratingsVisible = () => S.settings.difficulty !== 'hard' && S.settings.showRatings;
const era = () => ERAS.find(e => e.id === S.settings.era) ?? ERAS[0];
const combo = () => COMBOS.find(c => c.id === S.settings.combo) ?? COMBOS[0];

function go(screen) {
  S.screen = screen;
  render();
  window.scrollTo({ top: 0 });
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------- Draft logic ----------

function newDraft() {
  const slots = combo().slots.map((type, idx) => ({ idx, type, pick: null }));
  if (S.settings.impact) slots.push({ idx: slots.length, type: 'IMP', pick: null });
  S.draft = {
    slots, rerolls: DIFFICULTY[S.settings.difficulty].rerolls, rerollsUsed: 0,
    spin: null, spinning: false, selected: null, target: null, sort: 'rating',
  };
}

const picks = () => S.draft.slots.filter(s => s.pick).map(s => s.pick);
const openSlots = () => S.draft.slots.filter(s => !s.pick);
const overseasCount = () => picks().filter(pk => pk.p.overseas).length;
const drafted = p => picks().some(pk => pk.p.id === p.id);

function slotsFor(p) {
  const d = S.draft;
  return openSlots().filter(s =>
    (s.type === 'IMP' || p.slots.includes(s.type)) &&
    (S.settings.draftMode !== 'position' || d.target === null || s.idx === d.target));
}

function blockReason(p) {
  if (drafted(p)) return 'Already in your XI';
  if (S.settings.overseasCap && p.overseas && overseasCount() >= MAX_OVERSEAS) return `Overseas limit (${MAX_OVERSEAS}) reached`;
  if (!slotsFor(p).length) return S.settings.draftMode === 'position' ? `Can't play ${SLOTS[S.draft.slots[S.draft.target].type].label}` : 'No open slot for this role';
  return null;
}

function spinnable() {
  return teamSeasons(era()).filter(ts => squad(ts.team, ts.year).some(p => !blockReason(p)));
}

function startSpin(isReroll = false) {
  const d = S.draft;
  if (d.spinning || !openSlots().length) return;
  if (S.settings.draftMode === 'position' && d.target === null) { toast('Pick an open position first'); return; }
  if (isReroll) {
    if (d.rerolls <= 0) return;
    d.rerolls--; d.rerollsUsed++;
  }
  let pool = spinnable();
  if (d.spin && pool.length > 1) pool = pool.filter(ts => !(ts.team === d.spin.team && ts.year === d.spin.year));
  if (!pool.length) { toast('No squad has an eligible player — try another position'); return; }
  const landing = pool[Math.floor(Math.random() * pool.length)];
  d.spin = null; d.selected = null; d.spinning = true;
  render();
  animateReel(landing, () => {
    d.spinning = false;
    d.spin = landing;
    render();
  });
}

function animateReel(landing, done) {
  const teamEl = document.getElementById('reel-team');
  const yearEl = document.getElementById('reel-year');
  const all = teamSeasons(era());
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
  const d = S.draft;
  const slot = d.slots[slotIdx];
  if (!slot || slot.pick || blockReason(p)) return;
  const r = ratingsFor(p, d.spin.year, S.settings.ratingMode);
  slot.pick = { p, team: d.spin.team, year: d.spin.year, r, ovr: overall(p, r) };
  d.spin = null; d.selected = null; d.target = null;
  render();
}

function userTeam() {
  const xi = S.draft.slots.filter(s => s.type !== 'IMP').map(s => s.pick);
  const imp = S.draft.slots.find(s => s.type === 'IMP')?.pick;
  const order = [...xi];
  const bowlPool = [...xi];
  if (imp) {
    if ((imp.r.bat || 0) >= (imp.r.bowl || 0)) {
      const firstBowler = S.draft.slots.findIndex(s => SLOTS[s.type].kind === 'bowl');
      order.splice(firstBowler === -1 ? 7 : firstBowler, 0, imp);
    } else bowlPool.push(imp);
  }
  const bat = teamStrength(order).bat;
  const bowlSt = teamStrength(bowlPool);
  return {
    id: 'YOU', name: 'Your XI', short: 'YOUR XI', color: '#ff8a1f',
    bat, bowl: bowlSt.bowl, ovr: (bat + bowlSt.bowl) / 2, bowlingOptions: bowlSt.bowlingOptions,
    order, bowlers: bowlPool.filter(m => m.r.bowl > 0).sort((a, b) => b.r.bowl - a.r.bowl),
  };
}

function runSeason(sameOpponents = false) {
  const user = userTeam();
  if (!sameOpponents || !S.opponents) S.opponents = buildOpponents(era(), S.settings.ratingMode);
  S.result = simulateSeason(user, S.opponents);
  S.result.user = user;
  const r = S.result;
  const best = store.get('best', null);
  const score = r.wins * 10 + (r.champion ? 5 : 0);
  if (!best || score > best.score) store.set('best', { score, wins: r.wins, losses: r.losses, finish: r.finish });
  store.set('seasons', store.get('seasons', 0) + 1);
  if (r.perfectLeague) store.set('perfect', store.get('perfect', 0) + 1);
  go('season');
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
      <button class="btn btn-ghost" data-action="how">How it works</button>
    </div>
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

    <button class="btn btn-big btn-block" data-action="start">Start Draft →</button>
  </section>`;
}

function renderTeamSheet() {
  const d = S.draft;
  const posMode = S.settings.draftMode === 'position';
  const sel = d.selected !== null ? PLAYERS[d.selected] : null;
  const selSlots = sel && d.spin ? slotsFor(sel).map(s => s.idx) : [];
  const ps = picks();
  const avg = ps.length ? ps.reduce((a, pk) => a + pk.ovr, 0) / ps.length : 0;
  const bowlOpts = ps.filter(pk => pk.r.bowl >= 60).length;

  let batNo = 0;
  const rows = d.slots.map(s => {
    const isImp = s.type === 'IMP';
    const num = isImp ? 'IMP' : ++batNo;
    const kind = kindOf(s.type);
    const clickable = (!s.pick && posMode && !d.spin && !d.spinning) || selSlots.includes(s.idx);
    const cls = ['sheet-row', `k-${kind}`, s.pick ? 'filled' : 'empty',
      d.target === s.idx ? 'targeted' : '', selSlots.includes(s.idx) ? 'placeable' : '', clickable ? 'clickable' : ''].join(' ');
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
  const posMode = S.settings.draftMode === 'position';
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
    <button class="btn btn-big btn-block" data-action="simulate">Simulate season →</button>
  </div>`;
}

function renderDraft() {
  const d = S.draft;
  const left = openSlots().length;
  const posMode = S.settings.draftMode === 'position';
  let panel;
  if (!left) panel = renderReady();
  else if (d.spin) panel = renderSquad();
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
      <div class="hero-actions">
        <button class="btn" data-action="share">Share result</button>
        <button class="btn btn-outline" data-action="resim">Simulate again</button>
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
  if (S.screen === 'season' && !S.result) S.screen = 'home';
  app.innerHTML = {
    home: renderHome, setup: renderSetup, draft: renderDraft, season: renderSeason,
  }[S.screen]();
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
  if (el.dataset.place !== undefined) { place(PLAYERS[d.selected], Number(el.dataset.place)); return; }
  if (el.dataset.slot !== undefined) {
    const idx = Number(el.dataset.slot);
    if (d.spin && d.selected !== null) { place(PLAYERS[d.selected], idx); return; }
    if (S.settings.draftMode === 'position' && !d.spin) { d.target = d.target === idx ? null : idx; render(); }
    return;
  }
  if (el.dataset.player !== undefined) {
    const p = PLAYERS[Number(el.dataset.player)];
    if (blockReason(p)) return;
    if (S.settings.draftMode === 'position') { place(p, slotsFor(p)[0].idx); return; }
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
    case 'start': newDraft(); go('draft'); break;
    case 'spin': startSpin(false); break;
    case 'reroll': startSpin(true); break;
    case 'restart': if (confirm('Restart this run? Your picks will be lost.')) { newDraft(); render(); } break;
    case 'simulate': runSeason(false); break;
    case 'resim': runSeason(true); break;
    case 'share': share(); break;
  }
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action],[data-set],[data-sort],[data-place],[data-slot],[data-player]');
  if (!el || el.disabled) return;
  if (el.tagName === 'A') e.preventDefault();
  // A click on a place button inside a player card shouldn't also toggle the card.
  e.stopPropagation();
  handle(el);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('[role="button"]')) { handle(e.target); return; }
  if (e.code !== 'Space' || S.screen !== 'draft') return;
  const d = S.draft;
  if (d.spin || d.spinning || !openSlots().length) return;
  if (e.target.matches('input, textarea, button')) return;
  e.preventDefault();
  startSpin(false);
});

render();
