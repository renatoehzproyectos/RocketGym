import { createRequire } from 'node:module';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const R = createRequire(import.meta.url)('../../gym_rules.js');
const manifest = JSON.parse(fs.readFileSync(new URL('../../webbots/manifest.json', import.meta.url)));
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

const ladder = R.buildLadder(manifest.bots);
t('ladder has all 17 bots, weakest first', () => { assert.equal(ladder.length, 17); assert.equal(ladder[0].name, 'SkyBot'); assert.equal(ladder[16].name, 'Nexto (Toxic!)'); });
t('available ranks are the 5 with bots', () => assert.deepEqual(R.availableRanks(ladder), [0, 1, 2, 3, 4]));
t('mixed Plata–Oro counts as Silver', () => assert.equal(ladder.find(b => b.name === 'Noob Blue').rankIdx, 0));
t('demo bot is exactly one available rank up', () => {
  for (let r = 0; r < 4; r++) assert.equal(ladder.find(b => b.name === R.demoBotFor(ladder, r)).rankIdx, r + 1);
  assert.equal(R.demoBotFor(ladder, 4), null);
});
t('opponent/teammate selection sizes', () => {
  for (const [m, s] of Object.entries(R.MODES)) {
    assert.equal(R.opponentTeam(ladder, 5, s).length, s);
    assert.equal(R.teammates(ladder, 2, s).length, s - 1);
  }
});

const mk = (size = 1) => new R.MatchRules({ size });
const live = (m) => { m.startCountdown(); m.startPlay(); return m; };

t('clock runs only while playing', () => {
  const m = mk(); m.tick(10); assert.equal(m.clock, 300);
  live(m); m.tick(10); assert.equal(m.clock, 290);
  m.goal(0); assert.equal(m.state, 'goal'); m.tick(50); assert.equal(m.clock, 290);   // pausa de gol
});
t('match lasts 5 minutes and awards the leader', () => {
  const m = live(mk()); m.goal(0); m.afterGoal(); m.startPlay(); m.tick(300);
  assert.equal(m.state, 'ended'); assert.equal(m.result.winner, 0); assert.equal(m.result.reason, 'time');
});
t('tie at 0:00 goes to overtime, golden goal ends it', () => {
  const m = live(mk()); m.tick(300);
  assert.equal(m.state, 'playing'); assert.equal(m.phase, 'overtime');
  m.tick(30); assert.equal(m.clock, 30);               // cuenta hacia arriba
  m.goal(1); assert.equal(m.state, 'ended'); assert.equal(m.result.winner, 1); assert.equal(m.result.reason, 'overtime'); assert.ok(m.result.overtime);
});
t('3-goal lead does NOT forfeit', () => {
  const m = live(mk()); for (let i = 0; i < 3; i++) { m.goal(0); m.afterGoal(); m.startPlay(); }
  assert.notEqual(m.state, 'ended');
});
t('4-goal lead forfeits: real state transition, frozen, no more play', () => {
  const m = live(mk()); const ev = []; m.on((type, d) => ev.push(type));
  for (let i = 0; i < 4; i++) { m.goal(0); if (m.state !== 'ended') { m.afterGoal(); m.startPlay(); } }
  assert.equal(m.state, 'ended'); assert.equal(m.frozen, true);
  assert.equal(m.result.reason, 'forfeit'); assert.equal(m.result.winner, 0); assert.equal(m.result.forfeitBy, 1);
  assert.ok(ev.includes('end'));
  const before = m.clock, sc = m.score.slice();
  m.tick(10); m.goal(1); m.startCountdown(); m.startPlay();
  assert.equal(m.clock, before); assert.deepEqual(m.score, sc); assert.equal(m.state, 'ended');   // nada reabre el partido
});
t('forfeit applies when the bots lead by 4 too (mercy rule is symmetric)', () => {
  const m = live(mk()); for (let i = 0; i < 4 && m.state !== 'ended'; i++) { m.goal(1); if (m.state !== 'ended') { m.afterGoal(); m.startPlay(); } }
  assert.equal(m.result.reason, 'forfeit'); assert.equal(m.result.winner, 1);
});
t('forfeit needs a LEAD of 4, not 4 goals: 4-4 never forfeits', () => {
  const m = live(mk()); for (let i = 0; i < 4; i++) { m.goal(0); m.afterGoal(); m.startPlay(); m.goal(1); m.afterGoal(); m.startPlay(); }
  assert.notEqual(m.state, 'ended'); assert.deepEqual(m.score, [4, 4]);
});
t('goals outside play do not count', () => { const m = mk(); m.goal(0); assert.deepEqual(m.score, [0, 0]); });

const prog = (rank = 1) => R.newProgress(ladder, '1v1', rank);
const res = (winner, a, b, reason = 'time') => ({ winner, margin: Math.abs(a - b), reason, score: [a, b] });
t('convincing win (+2) advances to a stronger bot', () => {
  const p = prog(); const { next, outcome } = R.applyResult(ladder, p, res(0, 3, 1), 0);
  assert.equal(outcome, 'advance'); assert.equal(next.level, p.level + 1);
});
t('narrow win (+1) keeps the same bot', () => { const p = prog(); const { next, outcome } = R.applyResult(ladder, p, res(0, 2, 1), 0); assert.equal(outcome, 'stay'); assert.equal(next.level, p.level); });
t('forfeit win is always convincing', () => { assert.equal(R.applyResult(ladder, prog(), res(0, 4, 0, 'forfeit'), 0).outcome, 'advance'); });
t('a loss records who beat you (rematch target)', () => {
  const p = R.newProgress(ladder, '2v2', 2); const { next, outcome } = R.applyResult(ladder, p, res(1, 1, 3), 0);
  assert.equal(outcome, 'lost'); assert.equal(next.lostTo.opponents.length, 2); assert.equal(next.lostTo.teammates.length, 1);
});
t('beating Platinum bots raises the effective rank used for the demo bot', () => {
  let p = prog(2); while (ladder[p.level].rankIdx < 3) p = R.applyResult(ladder, p, res(0, 3, 0), 0).next;
  assert.equal(p.bestBeatenRank, 2);
  assert.equal(ladder.find(b => b.name === R.demoBotFor(ladder, R.effectiveRank(p.selectedRank, p.bestBeatenRank))).rankIdx, 3);
});
console.log(`\n${n} passed`);
