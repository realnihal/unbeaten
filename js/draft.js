// Draft rules shared by the browser and the leaderboard server. Everything here is pure and
// deterministic: given the same settings, seed and action log, a draft always ends up the same.
import {
  SLOTS, COMBOS, ERAS, MAX_OVERSEAS, PLAYERS,
  squad, teamSeasons, ratingsFor, overall, teamStrength, buildOpponents, simulateSeason,
  withRng, rngFrom,
} from './engine.js';

export const DIFFICULTY = {
  easy:   { name: 'Easy', rerolls: 3, note: '3 rerolls available' },
  normal: { name: 'Normal', rerolls: 1, note: '1 reroll available' },
  hard:   { name: 'Hard', rerolls: 0, note: 'No rerolls · ratings hidden' },
};

// The subset of settings that affects the game (and is stored with each run).
export function gameSettings(s) {
  return {
    combo: COMBOS.some(c => c.id === s.combo) ? s.combo : 'balanced',
    difficulty: DIFFICULTY[s.difficulty] ? s.difficulty : 'normal',
    draftMode: s.draftMode === 'position' ? 'position' : 'squad',
    ratingMode: s.ratingMode === 'prime' ? 'prime' : 'season',
    era: ERAS.some(e => e.id === s.era) ? s.era : 'all',
    impact: s.impact !== false,
    overseasCap: s.overseasCap !== false,
    showRatings: s.difficulty === 'hard' ? false : s.showRatings !== false,
  };
}

export const eraOf = settings => ERAS.find(e => e.id === settings.era) ?? ERAS[0];

export function createDraft(settings, seed) {
  const combo = COMBOS.find(c => c.id === settings.combo) ?? COMBOS[0];
  const slots = combo.slots.map((type, idx) => ({ idx, type, pick: null }));
  if (settings.impact) slots.push({ idx: slots.length, type: 'IMP', pick: null });
  return {
    settings, seed, slots,
    rerolls: DIFFICULTY[settings.difficulty].rerolls,
    spinCount: 0,
    spin: null,        // { team, year } currently on offer
    target: null,      // Position First: the slot being filled
    actions: [],
  };
}

export const canPlay = (p, type) => type === 'IMP' || p.slots.includes(type);
export const picks = d => d.slots.filter(s => s.pick).map(s => s.pick);
export const openSlots = d => d.slots.filter(s => !s.pick);
export const overseasCount = d => picks(d).filter(pk => pk.p.overseas).length;
export const isComplete = d => openSlots(d).length === 0;

export function slotsFor(d, p) {
  const posMode = d.settings.draftMode === 'position';
  return openSlots(d).filter(s => canPlay(p, s.type) && (!posMode || d.target === null || s.idx === d.target));
}

export function blockReason(d, p) {
  if (picks(d).some(pk => pk.p.id === p.id)) return 'Already in your XI';
  if (d.settings.overseasCap && p.overseas && overseasCount(d) >= MAX_OVERSEAS) return `Overseas limit (${MAX_OVERSEAS}) reached`;
  if (!slotsFor(d, p).length) {
    return d.settings.draftMode === 'position' && d.target !== null
      ? `Can't play ${SLOTS[d.slots[d.target].type].label}` : 'No open slot for this role';
  }
  return null;
}

// Franchise-seasons the wheel can land on: only squads with at least one draftable player.
export function spinPool(d) {
  let pool = teamSeasons(eraOf(d.settings)).filter(ts => squad(ts.team, ts.year).some(p => !blockReason(d, p)));
  if (d.spin && pool.length > 1) pool = pool.filter(ts => !(ts.team === d.spin.team && ts.year === d.spin.year));
  return pool;
}

class DraftError extends Error {}

function fail(msg) { throw new DraftError(msg); }

// Each action mutates the draft and is appended to the log. Invalid actions throw.
export function applyAction(d, a) {
  const posMode = d.settings.draftMode === 'position';
  switch (a.t) {
    case 'target': {
      if (!posMode) fail('target only in position mode');
      if (d.spin) fail('cannot change target after spinning');
      const s = d.slots[a.s];
      if (a.s !== null && (!s || s.pick)) fail('bad target');
      d.target = a.s;
      break;
    }
    case 'spin':
    case 'reroll': {
      if (isComplete(d)) fail('draft complete');
      if (a.t === 'spin' && d.spin) fail('squad already on offer');
      if (a.t === 'reroll') {
        if (!d.spin) fail('nothing to reroll');
        if (d.rerolls <= 0) fail('no rerolls left');
        d.rerolls--;
      }
      if (posMode && d.target === null) fail('pick a position first');
      const pool = spinPool(d);
      if (!pool.length) fail('no eligible squad');
      const rng = rngFrom(`${d.seed}:spin:${d.spinCount}`);
      d.spin = pool[Math.floor(rng() * pool.length)];
      d.spinCount++;
      break;
    }
    case 'pick': {
      if (!d.spin) fail('no squad on offer');
      const p = PLAYERS[a.p];
      if (!p || !squad(d.spin.team, d.spin.year).includes(p)) fail('player not in squad');
      if (blockReason(d, p)) fail(blockReason(d, p));
      const slot = slotsFor(d, p).find(s => s.idx === a.s);
      if (!slot) fail('player cannot play that slot');
      const r = ratingsFor(p, d.spin.year, d.settings.ratingMode);
      slot.pick = { p, team: d.spin.team, year: d.spin.year, r, ovr: overall(p, r) };
      d.spin = null;
      d.target = null;
      break;
    }
    case 'move': {
      if (posMode && d.spin) fail('cannot move while filling a position');
      if (!moveTargets(d, a.f).includes(a.to)) fail('illegal move');
      const from = d.slots[a.f], to = d.slots[a.to];
      [from.pick, to.pick] = [to.pick, from.pick];
      if (d.target !== null && d.slots[d.target].pick) d.target = null;
      break;
    }
    default:
      fail(`unknown action ${a.t}`);
  }
  d.actions.push(a);
  return d;
}

// Slots the player in `fromIdx` can go to: an empty slot they can play, or a filled one
// whose occupant can play the vacated slot (a swap).
export function moveTargets(d, fromIdx) {
  const from = d.slots[fromIdx];
  if (!from?.pick) return [];
  return d.slots.filter(s => s.idx !== fromIdx && canPlay(from.pick.p, s.type) &&
    (!s.pick || canPlay(s.pick.p, from.type))).map(s => s.idx);
}

// Rebuild a draft from its log. Throws DraftError with a reason if anything is illegal.
export function replayDraft(settings, seed, actions) {
  if (!Array.isArray(actions) || actions.length > 400) fail('bad action log');
  const d = createDraft(settings, seed);
  for (const a of actions) applyAction(d, a);
  if (!isComplete(d)) fail('draft incomplete');
  return d;
}

export function userTeam(d) {
  const xi = d.slots.filter(s => s.type !== 'IMP').map(s => s.pick);
  const imp = d.slots.find(s => s.type === 'IMP')?.pick;
  const order = [...xi];
  const bowlPool = [...xi];
  if (imp) {
    if ((imp.r.bat || 0) >= (imp.r.bowl || 0)) {
      const firstBowler = d.slots.findIndex(s => SLOTS[s.type].kind === 'bowl');
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

// The whole season (opponents, fixtures, every ball's worth of randomness) from one seed.
export function runSeason(d, seasonSeed) {
  return withRng(rngFrom(`${seasonSeed}:season`), () => {
    const user = userTeam(d);
    const opponents = buildOpponents(eraOf(d.settings), d.settings.ratingMode);
    const result = simulateSeason(user, opponents);
    return { ...result, user, opponents };
  });
}

// 0 no playoffs, 1 out in the Eliminator, 2 out in Qualifier 2, 3 runner-up, 4 champion.
export function stageOf(result) {
  return { Champions: 4, 'Runners-up': 3, 'Out in Qualifier 2': 2, 'Out in the Eliminator': 1 }[result.finish] ?? 0;
}

export function summarize(result) {
  const you = result.rows.find(r => r.id === 'YOU');
  return {
    wins: result.wins, losses: result.losses, position: result.position,
    finish: result.finish, stage: stageOf(result), nrr: Math.round(you.nrr * 1000) / 1000,
    teamRating: Math.round(result.user.ovr * 10) / 10,
  };
}

export function xiSummary(d) {
  return d.slots.map(s => ({ slot: s.type, playerId: s.pick.p.id, name: s.pick.p.name, team: s.pick.team, year: s.pick.year, ovr: s.pick.ovr }));
}

export { DraftError };
