'use strict';
// 게임 엔진 묶음. server.js 는 이 파일만 불러 씁니다.
const U = require('./util');
const AB = require('./abilities');
const { assignRoles } = require('./assign');
const { startNight, resolveNight } = require('./night');
const { resolveVote, resolveBoom, checkWin, weight, prophetCheck } = require('./vote');

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
  U, AB, assignRoles, startNight, resolveNight, resolveVote, resolveBoom, checkWin, weight, prophetCheck, setNightAct, setVoteAct, meView,
  chatInfo: AB.chatInfo, canSeeMsg: AB.canSeeMsg, knowsRole: AB.knowsRole, shownRoleTo: AB.shownRoleTo,
  canVote: AB.canVote, voteBlockReason: AB.voteBlockReason, GameError: U.GameError,
};
