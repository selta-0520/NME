'use strict';
const { ROLE: ROLE_, LOANABLE, MAGIC_DAY } = require('../roles');
// 게임 엔진 묶음. server.js 는 이 파일만 불러 씁니다.
const U = require('./util');
const AB = require('./abilities');
const { assignRoles } = require('./assign');
const { startNight, resolveNight } = require('./night');
const RPS = require('./rps');
const { resolveVote, resolveBoom, checkWin, weight, prophetCheck, tallyVote, announceTally, confirmTally, confirmVoters } = require('./vote');

// 밤 능력 선택 저장
function setNightAct(room, p, b) {
  if (room.phase !== 'night') U.fail('지금은 밤이 아니에요.');
  if (!p.alive) U.fail('죽은 사람은 능력을 쓸 수 없어요.');
  const opt = AB.nightOptions(room, p, b.mode);
  if (!opt) U.fail(p.s.blockNight === room.day ? '유혹당해서 오늘 밤에는 능력을 쓸 수 없어요.' : '지금 쓸 수 있는 밤 능력이 없어요.');
  const old = room.night.acts[p.id] || {};
  const act = { target: null, mode: opt.mode || null, text: typeof b.text === 'string' ? b.text.slice(0, 100) : (old.text || '') };
  const clear = b.target === null || b.target === '' || b.target === undefined;
  if (!clear) {
    if (!opt.targets.includes(b.target)) U.fail('그 대상은 선택할 수 없어요.');
    act.target = b.target;
  } else if (b.keepTarget && old.target && opt.targets.includes(old.target)) act.target = old.target; // 모드만 바꿀 때
  if (act.target || act.text || act.mode) room.night.acts[p.id] = act; else delete room.night.acts[p.id];
  // 마술사: 능력을 쓰기로 하면 바로 시민 팀 직업 하나를 랜덤으로 얻는다 (그날 밤 그 능력을 쓸 수 있다)
  if (p.role === 'magician' && !p.s.loan && act.mode === 'on') {
    const en = room.settings.enabledRoles;
    // 밤 능력 + 낮(아침) 능력 직업 모두 후보 (낮 능력은 이 밤이 지나고 맞는 낮까지 쓴다)
    const pool = LOANABLE.concat(MAGIC_DAY).filter((k, i, a) => a.indexOf(k) === i && ROLE_[k] && ROLE_[k].team === 'citizen' && en.includes(k) && k !== 'magician' && (k !== 'prosecutor' && k !== 'lawyer' || room.settings.finalDefense));
    if (!pool.length) { U.priv(room, p, '🎩 이번 판에는 얻을 수 있는 시민 팀 능력이 없어요.'); return; }
    const k = U.pick(pool);
    p.s.magicUsed = room.day;
    delete room.night.acts[p.id];
    if (MAGIC_DAY.includes(k)) {
      p.s.dayLoan = k; if (p.s.uc) p.s.uc[k] = 0;
      if (k === 'detective') { p.s.loan = k; p.s.lnS = {}; } // 탐정은 밤에 첫 번째 사람을 고르고, 낮 투표시간에 두 번째 사람을 고른다
      const when = k === 'detective' ? '오늘 밤에 첫 번째 사람을 고르고, 다음 낮 투표시간에 두 번째 사람을 골라요' : '다음 낮에';
      U.priv(room, p, `🎩 마술 성공! "${ROLE_[k].name}"의 능력을 얻었어요. ${when} 쓸 수 있어요. (${ROLE_[k].desc})`);
      return;
    }
    p.s.loan = k; p.s.lnS = {};
    U.priv(room, p, `🎩 마술 성공! 오늘 밤 "${ROLE_[k].name}"의 능력을 쓸 수 있어요. (${ROLE_[k].desc})`);
  }
}

// 투표시간 능력 선택 저장
function setVoteAct(room, p, b) {
  if (room.phase !== 'vote') U.fail('지금은 투표 시간이 아니에요.');
  if (!p.alive) U.fail('죽은 사람은 능력을 쓸 수 없어요.');
  const opt = AB.voteOptions(room, p);
  if (!opt) U.fail('투표시간에 쓸 수 있는 능력이 없어요.');
  if (b.target === null || b.target === '' || b.target === undefined) delete room.voteActs[p.id];
  else {
    if (!opt.targets.includes(b.target)) U.fail('그 대상은 선택할 수 없어요.');
    room.voteActs[p.id] = { target: b.target };
  }
}

// 이 사람에게 보여 줄 "내 상태" (직업, 능력 선택지 등)
function meView(room, p) {
  const me = { role: p.role, alive: p.alive, vote: room.votes[p.id] || null, team: U.teamOf(p), info: AB.infoLines(room, p), chat: AB.chatInfo(room, p) };
  me.canVote = AB.canVote(room, p);
  const n = AB.nightOptions(room, p);
  if (n) me.night = n;
  const v = AB.voteOptions(room, p);
  if (v) me.voteAbility = v;
  const bm = AB.boomOptions(room, p);
  if (bm) me.boom = bm;
  if (p.origRole === 'prophet' && room.phase !== 'ended') {
    me.predict = { open: room.phase === 'night' && room.day === 1, ids: room.players.filter((x) => x !== p).map((x) => x.id), guesses: p.guess || {} };
  }
  if (room.phase === 'confirm' && p.alive && U.dayRole(p) === 'judge' && U.usesLeft(room, p, 'judge') > 0 && !room.judgeVerdict && room.defense && room.defense.id !== p.id) me.judge = { open: true };
  if ((U.dayRole(p) === 'prosecutor' || U.dayRole(p) === 'lawyer') && p.alive && room.defense && ['defense', 'speak', 'confirm'].includes(room.phase) && room.defense.id !== p.id) me.extra = { open: room.phase === 'defense', use: !!(room.extra && room.extra[p.id]) };
  if (room.phase === 'day' && p.alive && p.role === 'sniper' && p.s.sniped !== room.day) { // 저격수: 낮에 직업을 맞혀 저격
    const en = room.settings.enabledRoles.filter((k) => ROLE_[k]);
    for (const k of ['citizen', 'mafia', 'evil']) if (!en.includes(k)) en.push(k);
    me.snipe = { open: true, targets: U.alive(room).filter((x) => x.id !== p.id).map((x) => x.id), roles: en.map((k) => ({ key: k, name: ROLE_[k].name })) };
  }
  if (room.phase === 'rps') {
    const m = RPS.matchOf(room, p);
    if (m) { const mine = m.b === p.id; const opp = U.byId(room, mine ? m.t : m.b); me.rps = { side: mine ? 'bettor' : 'target', opp: opp ? opp.name : '', pick: (mine ? m.bm : m.tm) || null }; }
  }
  if (room.phase === 'night' && room.night && p.alive && U.canAttackAsMafia(room, p)) {
    me.mafiaPicks = {};
    for (const [pid, a] of Object.entries(room.night.acts)) {
      const q = U.byId(room, pid);
      if (q && a.target && U.canAttackAsMafia(room, q)) me.mafiaPicks[pid] = a.target;
    }
  }
  return me;
}

module.exports = {
  U, AB, assignRoles, startNight, resolveNight, resolveVote, resolveBoom, checkWin, weight, prophetCheck, tallyVote, announceTally, confirmTally, confirmVoters, setNightAct, setVoteAct, meView, rpsMatches: RPS.rpsMatches, rpsPick: RPS.rpsPick, rpsDone: RPS.rpsDone, rpsResolve: RPS.rpsResolve,
  chatInfo: AB.chatInfo, canSeeMsg: AB.canSeeMsg, knowsRole: AB.knowsRole, shownRoleTo: AB.shownRoleTo,
  canVote: AB.canVote, voteBlockReason: AB.voteBlockReason, GameError: U.GameError,
};
