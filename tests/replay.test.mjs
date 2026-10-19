// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMBOS, ERAS, PLAYERS, squad } from '../js/engine.js';
import {
  gameSettings, createDraft, applyAction, replayDraft, runSeason, summarize,
  slotsFor, blockReason, moveTargets, isComplete, DraftError,
} from '../js/draft.js';

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

// Plays a full draft with random (but legal) choices, the way a human might.
function botDraft(settings, seed) {
  const d = createDraft(settings, seed);
  while (!isComplete(d)) {
    if (settings.draftMode === 'position' && d.target === null) {
      applyAction(d, { t: 'target', s: pick(d.slots.filter(s => !s.pick)).idx });
    }
    applyAction(d, { t: 'spin' });
    if (d.rerolls > 0 && Math.random() < 0.3) applyAction(d, { t: 'reroll' });
    const options = squad(d.spin.team, d.spin.year).filter(p => !blockReason(d, p));
    const p = pick(options);
    applyAction(d, { t: 'pick', p: p.id, s: pick(slotsFor(d, p)).idx });
    if (Math.random() < 0.2 && settings.draftMode === 'squad') {
      const filled = d.slots.filter(s => s.pick).map(s => s.idx);
      const from = pick(filled);
      const targets = moveTargets(d, from);
      if (targets.length) applyAction(d, { t: 'move', f: from, to: pick(targets) });
    }
  }
  return d;
}

function randomSettings() {
  return gameSettings({
    combo: pick(COMBOS).id,
    difficulty: pick(['easy', 'normal', 'hard']),
    draftMode: pick(['squad', 'position']),
    ratingMode: pick(['season', 'prime']),
    era: pick(ERAS).id,
    impact: Math.random() < 0.7,
    overseasCap: Math.random() < 0.8,
  });
}

const fingerprint = r => JSON.stringify({
  s: summarize(r),
  log: r.log.map(m => [m.stage, m.opp.id, m.won, m.margin, m.userInn.runs, m.oppInn.runs, m.topBat.name, m.topBat.runs]),
  table: r.rows.map(x => [x.id, x.pts, x.nrr.toFixed(6)]),
  po: r.playoffs.map(g => [g.a.id, g.b.id, g.win.id, g.res.margin]),
});

test('replaying an action log rebuilds the same draft and season', () => {
  for (let i = 0; i < 150; i++) {
    const settings = randomSettings();
    const seed = `seed-${i}-${Math.random()}`;
    const original = botDraft(settings, seed);
    const replayed = replayDraft(settings, seed, JSON.parse(JSON.stringify(original.actions)));
    assert.deepEqual(
      replayed.slots.map(s => [s.type, s.pick.p.id, s.pick.team, s.pick.year]),
      original.slots.map(s => [s.type, s.pick.p.id, s.pick.team, s.pick.year]),
    );
    const seasonSeed = `season-${i}`;
    assert.equal(fingerprint(runSeason(replayed, seasonSeed)), fingerprint(runSeason(original, seasonSeed)));
  }
});

test('the same seed always lands the same spins', () => {
  const settings = gameSettings({});
  const a = createDraft(settings, 'fixed');
  const b = createDraft(settings, 'fixed');
  applyAction(a, { t: 'spin' });
  applyAction(b, { t: 'spin' });
  assert.deepEqual(a.spin, b.spin);
});

test('tampered logs are rejected', () => {
  const settings = gameSettings({ difficulty: 'normal' });
  const seed = 'tamper';
  const d = botDraft(settings, seed);
  const actions = d.actions;

  // Swap a pick for a player who wasn't in the spun squad.
  const firstPick = actions.findIndex(a => a.t === 'pick');
  const spun = createDraft(settings, seed);
  for (const a of actions.slice(0, firstPick)) applyAction(spun, a);
  const outsider = PLAYERS.find(p => !squad(spun.spin.team, spun.spin.year).includes(p));
  const forged = actions.map((a, i) => (i === firstPick ? { ...a, p: outsider.id } : a));
  assert.throws(() => replayDraft(settings, seed, forged), DraftError);

  // Extra rerolls beyond the difficulty allowance.
  const greedy = [{ t: 'spin' }, { t: 'reroll' }, { t: 'reroll' }];
  assert.throws(() => replayDraft(settings, seed, greedy), DraftError);

  // A different seed means the spins no longer match the picks.
  assert.throws(() => replayDraft(settings, 'other-seed', actions), DraftError);

  // Unfinished drafts can't be submitted.
  assert.throws(() => replayDraft(settings, seed, actions.slice(0, -1)), DraftError);
});
