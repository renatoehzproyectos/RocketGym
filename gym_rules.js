// Reglas puras del gimnasio (sin DOM, sin física): escalera de bots, selección de rivales y la
// máquina de estados del partido (reloj, tiempo extra y forfeit). gym.js las conecta al juego.
// Se puede probar en Node: tools/gym/test_rules.mjs
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- rangos y escalera
  const RANKS = ['Silver', 'Gold', 'Platinum', 'Diamond', 'Grand Champion'];
  const RANK_ES = { plata: 0, oro: 1, platino: 2, diamante: 3, 'gran campeón': 4, 'gran campeon': 4 };
  const MODES = { '1v1': 1, '2v2': 2, '3v3': 3 };

  // "Plata–Oro", "Platino*", "Gran Campeón*" -> índice en RANKS. Un rango mixto cuenta como el menor.
  function rankIndex(label) {
    if (label == null) return -1;
    const first = String(label).replace(/\*/g, '').split(/[–-]/)[0].trim().toLowerCase();
    if (first in RANK_ES) return RANK_ES[first];
    const i = RANKS.findIndex((r) => r.toLowerCase() === first);
    return i;
  }

  // manifest.bots -> [{name, order, rank, rankIdx}] ordenado de más débil a más fuerte.
  function buildLadder(botsManifest) {
    return Object.keys(botsManifest)
      .map((name) => ({ name, order: botsManifest[name].order || 0, rank: botsManifest[name].rank, rankIdx: rankIndex(botsManifest[name].rank) }))
      .filter((b) => b.rankIdx >= 0)
      .sort((a, b) => a.order - b.order);
  }

  // Rangos que de verdad tienen bots ("rango disponible").
  function availableRanks(ladder) {
    return Array.from(new Set(ladder.map((b) => b.rankIdx))).sort((a, b) => a - b);
  }

  // Primer escalón (índice en la escalera) de un rango.
  function firstLevelOfRank(ladder, rankIdx) {
    return ladder.findIndex((b) => b.rankIdx === rankIdx);
  }

  // Rival de `size` bots para un escalón: el bot del escalón más los inmediatamente inferiores.
  function opponentTeam(ladder, level, size) {
    const out = [];
    for (let i = 0; i < size; i++) out.push(ladder[Math.max(0, level - i)].name);
    return out;
  }

  // Compañeros (size-1) del mismo rango que el jugador, repartidos entre los bots de ese rango.
  function teammates(ladder, rankIdx, size) {
    const pool = ladder.filter((b) => b.rankIdx === rankIdx);
    const src = pool.length ? pool : ladder.slice(0, 1);
    const out = [];
    for (let i = 0; i < size - 1; i++) out.push(src[i % src.length].name);
    return out;
  }

  // Rango efectivo del jugador: el mayor entre el elegido y el del bot más fuerte que venció con claridad.
  function effectiveRank(selectedRankIdx, bestBeatenRankIdx) {
    return Math.max(selectedRankIdx, bestBeatenRankIdx == null ? -1 : bestBeatenRankIdx);
  }

  // Bot de EXACTAMENTE un rango disponible por encima del jugador. null si ya está en el tope.
  // Dentro de ese rango se elige el más fuerte (el que mejor demuestra la solución).
  function demoBotFor(ladder, effRankIdx) {
    const higher = availableRanks(ladder).filter((r) => r > effRankIdx);
    if (!higher.length) return null;
    const target = higher[0];
    const inRank = ladder.filter((b) => b.rankIdx === target);
    return inRank[inRank.length - 1].name;
  }

  // ---------------------------------------------------------------- reglas del partido
  const MATCH_SECONDS = 300;      // 5 minutos
  const FORFEIT_LEAD = 4;         // ventaja que provoca el forfeit
  const CONVINCING_MARGIN = 2;    // victoria "convincente"

  // Máquina de estados. Estados: idle -> countdown -> playing -> goal -> countdown -> ... -> ended.
  // El forfeit es una transición de ESTADO: al marcar la ventaja de FORFEIT_LEAD el partido pasa a 'ended'
  // con reason 'forfeit' y se congela (frozen). Ninguna parte de la UI decide esto.
  class MatchRules {
    constructor(opts) {
      opts = opts || {};
      this.size = opts.size || 1;
      this.matchSeconds = opts.matchSeconds || MATCH_SECONDS;
      this.forfeitLead = opts.forfeitLead || FORFEIT_LEAD;
      this.state = 'idle';
      this.phase = 'regulation';   // 'regulation' | 'overtime'
      this.clock = this.matchSeconds;   // regulación: cuenta atrás; tiempo extra: cuenta hacia arriba
      this.score = [0, 0];         // [azul, naranja]
      this.result = null;
      this.goals = [];             // {team, at, phase}
      this.elapsed = 0;            // segundos de juego efectivo
      this.frozen = false;
      this.listeners = [];
    }
    on(fn) { this.listeners.push(fn); return this; }
    _emit(type, data) { this.listeners.forEach((fn) => fn(type, data || {}, this)); }
    lead(team) { return this.score[team] - this.score[1 - team]; }

    startCountdown() {
      if (this.state === 'ended') return false;
      this.state = 'countdown'; this._emit('state', { state: this.state }); return true;
    }
    startPlay() {
      if (this.state !== 'countdown') return false;
      this.state = 'playing'; this._emit('state', { state: this.state }); return true;
    }

    // dt = segundos de simulación transcurridos. Solo corre el reloj en 'playing'.
    tick(dt) {
      if (this.state !== 'playing') return;
      this.elapsed += dt;
      if (this.phase === 'regulation') {
        this.clock = Math.max(0, this.clock - dt);
        if (this.clock <= 0) this._timeUp();
      } else {
        this.clock += dt;
      }
    }
    _timeUp() {
      if (this.score[0] !== this.score[1]) this._end(this.score[0] > this.score[1] ? 0 : 1, 'time');
      else {
        this.phase = 'overtime'; this.clock = 0;
        this._emit('overtime', {});
      }
    }

    // Gol de `team` (0 azul, 1 naranja). Devuelve el estado resultante.
    goal(team) {
      if (this.state !== 'playing') return this.state;     // goles fuera de juego no cuentan
      this.score[team]++;
      this.goals.push({ team, at: this.elapsed, phase: this.phase });
      this._emit('goal', { team });
      if (this.phase === 'overtime') { this._end(team, 'overtime'); return this.state; }   // gol de oro
      if (this.lead(team) >= this.forfeitLead) { this._end(team, 'forfeit'); return this.state; }
      this.state = 'goal'; this._emit('state', { state: this.state });
      return this.state;
    }
    afterGoal() {    // el juego terminó la pausa de gol: toca el saque
      if (this.state !== 'goal') return false;
      return this.startCountdown();
    }

    _end(winner, reason) {
      this.state = 'ended'; this.frozen = true;
      this.result = { winner, loser: 1 - winner, reason, score: this.score.slice(), margin: Math.abs(this.score[0] - this.score[1]),
        overtime: this.phase === 'overtime', forfeitBy: reason === 'forfeit' ? 1 - winner : null };
      this._emit('state', { state: this.state });
      this._emit('end', this.result);
    }

    snapshot() {
      return { state: this.state, phase: this.phase, clock: this.clock, score: this.score.slice(), frozen: this.frozen, result: this.result };
    }
  }

  // Victoria convincente del equipo `team`: forfeit del rival o margen suficiente.
  function isConvincingWin(result, team) {
    if (!result || result.winner !== team) return false;
    return result.reason === 'forfeit' || result.margin >= CONVINCING_MARGIN;
  }

  // ---------------------------------------------------------------- progreso entre partidos
  // progress: {mode, selectedRank, level, bestBeatenRank, lostTo}
  function newProgress(ladder, mode, selectedRank) {
    return { mode, size: MODES[mode], selectedRank, level: Math.max(0, firstLevelOfRank(ladder, selectedRank)), bestBeatenRank: null, lostTo: null };
  }

  // Aplica el resultado de un partido. Devuelve {next, outcome}; outcome: 'advance' | 'stay' | 'lost'.
  function applyResult(ladder, progress, result, playerTeam) {
    const p = Object.assign({}, progress);
    if (result.winner === playerTeam) {
      const beaten = ladder[p.level];
      if (isConvincingWin(result, playerTeam)) {
        p.bestBeatenRank = Math.max(p.bestBeatenRank == null ? -1 : p.bestBeatenRank, beaten.rankIdx);
        p.level = Math.min(ladder.length - 1, p.level + 1);
        return { next: p, outcome: 'advance' };
      }
      return { next: p, outcome: 'stay' };       // ganó, pero apretado: mismo rival
    }
    p.lostTo = { level: p.level, opponents: opponentTeam(ladder, p.level, p.size),
      teammates: teammates(ladder, p.selectedRank, p.size) };
    return { next: p, outcome: 'lost' };
  }

  const api = { RANKS, MODES, MATCH_SECONDS, FORFEIT_LEAD, CONVINCING_MARGIN, rankIndex, buildLadder, availableRanks,
    firstLevelOfRank, opponentTeam, teammates, effectiveRank, demoBotFor, MatchRules, isConvincingWin, newProgress, applyResult };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GymRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
