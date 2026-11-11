'use strict';
// 엔진 공용 도구. server.js 가 시작할 때 U.io 를 채워 줍니다.
const crypto = require('crypto');
const { ROLE } = require('../roles');

const U = {
  // sys(room,text) 전체 공지 / priv(room,player,text) 개인 메시지 / kill(room,player,how) 사망 처리
  io: { sys() {}, priv() {}, kill() {} },
};

// 규칙 위반 등 사용자에게 보여 줄 오류
class GameError extends Error {}
U.GameError = GameError;
U.fail = (msg) => { throw new GameError(msg); };

U.shuffle = (a) => {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
U.pick = (a) => a[crypto.randomInt(a.length)];
U.byId = (room, id) => room.players.find((p) => p.id === id);
U.alive = (room) => room.players.filter((p) => p.alive);
U.roleName = (k) => ROLE[k].name;
U.names = (list) => list.map((p) => p.name).join(', ');

// 팀: 혁명가처럼 팀이 바뀐 경우(p.team)를 우선
U.teamOf = (p) => p.team || ROLE[p.role].team;

// 마피아 팀 대화방 멤버 (접선한 마피아 팀, 밀고자 제외)
U.inMafiaChat = (p) => ROLE[p.role].team === 'mafia' && !!p.contacted && p.role !== 'informant';
// "마피아" 로 인정되는 대상 (접선 판정용)
U.isMafiaKnown = (p) => ROLE[p.role].team === 'mafia' && (p.role === 'mafia' || !!p.contacted);

// 조사 결과에 보이는 직업 (은둔자는 마피아, 사기꾼는 흉내 낸 직업)
U.shownRole = (p) => {
  const r = p.s.disguise || p.role;
  return r === 'hermit' ? 'mafia' : r;
};
U.shownTeam = (p) => ROLE[U.shownRole(p)].team;

U.priv = (room, p, text) => U.io.priv(room, p, text);
U.sys = (room, text) => U.io.sys(room, text);

// 마피아가 직접 공격할 수 있는 사람들 (마피아 + 마피아가 모두 죽은 뒤의 접선한 사기꾼)
U.canAttackAsMafia = (room, p) => {
  if (!p.alive) return false;
  if (p.role === 'mafia') return true;
  if (p.role === 'doppelganger' && p.contacted) return !room.players.some((x) => x.alive && x.role === 'mafia');
  return false;
};

// 직업을 바꿀 때 (도굴꾼, 지원자, 광대) 상태 초기화
U.setRole = (room, p, role, quiet) => {
  p.role = role; p.s = {}; p.team = null;
  p.contacted = role === 'mafia';
  if (role === 'mafia' && !quiet) {
    const mates = room.players.filter((x) => x !== p && x.alive && U.inMafiaChat(x));
    for (const m of mates) U.priv(room, m, `🔪 새 마피아 ${p.name}님이 합류했습니다.`);
    U.priv(room, p, `🔪 당신은 마피아입니다. 마피아 팀: ${U.names(mates) || '(없음)'}`);
  }
};

// 접선 (마피아 팀 특수 직업 ↔ 마피아)
U.contact = (room, p, mafiaTarget) => {
  if (p.contacted || p.loaning) return; // (도둑이 훔친 능력으로는 접선하지 않는다)
  p.contacted = true;
  const mates = room.players.filter((x) => x !== p && x.alive && U.inMafiaChat(x));
  if (p.role === 'informant') {
    U.priv(room, p, `🤝 ${mafiaTarget.name}님과 접선했습니다! (마피아 팀과 대화는 할 수 없어요) 마피아 팀: ${U.names(mates)}`);
    for (const m of mates) U.priv(room, m, `🤝 밀고자 ${p.name}님이 접선했습니다. (대화는 불가)`);
    return;
  }
  U.priv(room, p, `🤝 접선했습니다! 이제 마피아 팀과 밤에 대화할 수 있어요. 마피아 팀: ${U.names(mates)}`);
  for (const m of mates) U.priv(room, m, `🤝 ${U.roleName(p.role)} ${p.name}님이 접선했습니다!`);
};

// 생존자: 죽을 위기를 2번까지 넘긴다. 넘겼으면 true
U.survive = (room, p) => {
  if (!p || p.role !== 'survivor') return false;
  const used = p.s.surv || 0;
  if (used >= 2) return false;
  p.s.surv = used + 1;
  U.priv(room, p, `🍀 죽을 뻔했지만 살아남았습니다! (남은 목숨 ${2 - p.s.surv}번)`);
  return true;
};

// 파괴자가 한 판에 쓸 수 있는 횟수: 게임 시작 인원의 3분의 1 (내림, 최소 1번)
U.destroyLimit = (room) => Math.max(1, Math.floor((room.startN || room.players.length) / 3));

// 도둑: 훔친 능력으로 잠시 바꿔서 실행한다 (역할·상태를 임시로 바꿨다가 되돌림)
U.withLoan = (p, fn) => {
  const r = p.role, s = p.s;
  p.role = s.loan; p.s = s.lnS || (s.lnS = {}); p.loaning = true;
  try { return fn(); } finally { p.role = r; p.s = s; p.loaning = false; }
};

// 신봉자의 주인 정하기 (시민·마피아 팀 중 랜덤). quiet 이면 알림을 보내지 않는다
U.masterNote = (room, f) => {
  const m = f.s.master ? U.byId(room, f.s.master) : null;
  if (m) U.priv(room, f, `🙇 당신의 주인은 ${m.name}님입니다. (${U.teamOf(m) === 'mafia' ? '마피아' : '시민'} 팀) 주인이 끝까지 살아남고 그 팀이 이기면 함께 우승해요.`);
};
U.assignMaster = (room, f, quiet) => {
  const c = room.players.filter((x) => x !== f && x.role !== 'follower' && U.teamOf(x) !== 'neutral');
  const m = c.length ? U.pick(c) : null;
  f.s.master = m ? m.id : null;
  if (!quiet) U.masterNote(room, f);
  return m;
};

// 능력을 쓴 사람이 대상에게 "상호작용" 했다는 기록 (지원자·혁명가가 사용)
U.touch = (room, actor, target) => {
  if (!actor || !target || actor === target) return;
  room.touches.push({ from: actor.id, to: target.id });
  if (target.role === 'revolutionary' && target.alive && !target.s.joined) {
    const t = actor.loaning ? 'neutral' : U.teamOf(actor); // (도둑이 훔친 능력은 팀을 바꾸지 않는다)
    if (t === 'mafia' || t === 'citizen') {
      target.s.joined = true; target.team = t;
      U.priv(room, target, `✊ 누군가의 능력을 받아 ${t === 'mafia' ? '마피아' : '시민'} 팀이 되었습니다! 이제 그 팀의 승리가 당신의 승리입니다.`);
    }
  }
};

module.exports = U;
