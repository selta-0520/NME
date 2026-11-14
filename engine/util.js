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
  const r0 = p.s.disguise || p.role;
  const r = r0 === 'hermit' ? 'mafia' : r0;
  if (p.s.forged) return ROLE[r].team === 'mafia' ? 'citizen' : 'mafia'; // 위조범: 조사 결과를 거꾸로 위조
  return r;
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
U.destroyLimit = (room) => { const c = (room.settings && room.settings.destroyMax) | 0; return c > 0 ? c : Math.max(1, Math.floor((room.startN || room.players.length) / 3)); };
// 횟수 제한이 있는 능력: 방 설정(settings.uses)으로 조절 (훔친 능력은 항상 1회)
U.USE_KEYS = ['reporter', 'agitator', 'priest', 'angel', 'scientist', 'judge', 'soldier', 'madman', 'guardian'];
U.dayRole = (p) => (p.role === 'magician' && p.s && p.s.dayLoan ? p.s.dayLoan : p.role); // 낮 능력 기준 직업 (마술사가 얻은 낮 능력 포함)
U.maxUses = (room, p, key) => (p && (p.loaning || (p.role === 'magician' && p.s.dayLoan)) ? 1 : Math.max(1, ((room.settings.uses || {})[key]) | 0 || 1));
U.usedCount = (p, key) => (p.s.uc || {})[key] || 0;
U.useOne = (p, key) => { p.s.uc = p.s.uc || {}; p.s.uc[key] = (p.s.uc[key] || 0) + 1; };
U.usesLeft = (room, p, key) => U.maxUses(room, p, key) - U.usedCount(p, key);
// "(1회)" / "(남은 2/3회)" 같은 표시
U.usesTag = (room, p, key) => { const m = U.maxUses(room, p, key); return m <= 1 ? '1회' : `남은 ${U.usesLeft(room, p, key)}/${m}회`; };

// 내기꾼이 우승하려면 가위바위보로 이겨야 하는 사람 수: 게임 시작 인원의 5분의 1 (올림, 최소 1명)
U.bettorNeed = (room) => Math.max(1, Math.ceil((room.startN || room.players.length) / 5));
// 약사: 접선한 의사가 죽었는지(= 약을 줄 수 있는 상태인지)
U.pharmaArmed = (room, p) => { if (p.s.armed) return true; const d = p.s.doc && U.byId(room, p.s.doc); if (d && !d.alive) { p.s.armed = true; return true; } return false; };
U.heroNeed = (room) => Math.max(1, ((room.settings && room.settings.heroStack) | 0) || 3); // 히어로 전향에 필요한 선행 스택
// 히어로·빌런: 서로 접선해 슈퍼가 된 짝 (둘 다 상태가 맞아야 한다)
U.superMate = (room, p) => {
  if (!p.s || !p.s.sup || !p.s.mate || (p.role !== 'hero' && p.role !== 'villain')) return null;
  const m = U.byId(room, p.s.mate);
  return m && m.s && m.s.sup && m.s.mate === p.id && ((p.role === 'hero' && m.role === 'villain') || (p.role === 'villain' && m.role === 'hero')) ? m : null;
};
U.isSuper = (room, p) => !!U.superMate(room, p);
// 히어로 ↔ 빌런이 서로 기다림 상태가 되면 접선해서 슈퍼히어로·슈퍼빌런이 된다
U.superCheck = (room, a, b) => {
  if (!a || !b || !a.alive || !b.alive) return false;
  if (U.isSuper(room, a) || U.isSuper(room, b)) return false;
  if (a.s.waitFor !== b.id || b.s.waitFor !== a.id) return false;
  a.s.sup = true; b.s.sup = true; a.s.mate = b.id; b.s.mate = a.id; a.s.waitFor = null; b.s.waitFor = null;
  for (const [x, y] of [[a, b], [b, a]]) U.priv(room, x, `🦸🦹 ${y.name}님과 접선했습니다! 이제 당신은 슈퍼${x.role === 'hero' ? '히어로' : '빌런'}예요. 밤마다 1명을 죽일 수 있고, 살아남은 사람이 슈퍼들뿐이 되면 우승해요. (슈퍼가 된 뒤에는 전향하지 않아요)`);
  return true;
};
// 빌런: 악행 스택이 살아 있는 마피아 수에 도달하면 마피아 팀으로 전향
U.villainCheck = (room, p) => {
  if (p.role !== 'villain' || !p.alive || U.isSuper(room, p) || !p.s.evil) return false;
  const max = room.players.filter((x) => x.alive && U.teamOf(x) === 'mafia').length;
  if (max <= 0 || p.s.evil < max) return false;
  U.priv(room, p, '🦹 악행 스택이 가득 찼습니다! 마피아 팀으로 전향합니다. (원래 능력은 사라져요)');
  U.setRole(room, p, 'mafia');
  return true;
};
// 마술사: 능력을 쓸 수 있는 밤인가 (쓰고 나면 하루 쉰다)
U.magicReady = (room, p) => !p.s.magicUsed || room.day >= p.s.magicUsed + 2;
// 수호자: 그날 투표 후보에서 제외된 사람
U.voteImmune = (room, p) => !!p && p.alive && p.s && p.s.voteImmune === room.day;

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
