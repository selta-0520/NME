'use strict';
// 투표 처리 + 승리 판정
const { ROLE } = require('../roles');
const U = require('./util');
const AB = require('./abilities');
const { checkAssassins } = require('./night');

const weight = (p) => (p.role === 'politician' ? 2 : 1);

function resolveVote(room) {
  const day = room.day;
  const tally = {}; let skip = 0;
  const madamVotes = [];
  for (const [vid, t] of Object.entries(room.votes)) {
    const v = U.byId(room, vid);
    if (!v || !v.alive || !AB.canVote(room, v)) continue;
    if (t === 'skip') { skip++; continue; }
    const target = U.byId(room, t);
    if (!target) continue;
    tally[t] = (tally[t] || 0) + weight(v);
    if (v.role === 'madam') madamVotes.push({ madam: v, target });
  }
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const summary = entries.map(([id, c]) => `${U.byId(room, id).name} ${c}표`).concat(skip ? [`기권 ${skip}`] : []);
  U.sys(room, `🗳 투표 결과: ${summary.length ? summary.join(', ') : '투표가 없었습니다.'}`);

  // 투표시간 능력은 처형 전에 상태를 기록해 둔다 (처형으로 죽어도 결과는 전달)
  const abil = Object.entries(room.voteActs).map(([pid, a]) => ({ p: U.byId(room, pid), t: U.byId(room, a.target) }))
    .filter((x) => x.p && x.p.alive && x.t);

  // ---- 처형
  if (entries.length && (entries.length === 1 || entries[0][1] > entries[1][1])) {
    const T = U.byId(room, entries[0][0]);
    if (T.role === 'politician') U.sys(room, `🏛 정치인 ${T.name}님은 투표로 죽지 않습니다!`);
    else if (T.role === 'beggar' && !T.s.met) U.sys(room, `🙏 거지 ${T.name}님은 투표로 죽지 않습니다!`);
    else if (T.role === 'madman' && !T.s.shieldUsed) { T.s.shieldUsed = true; U.sys(room, `🌀 ${T.name}님은 처형 투표에서 살아남았습니다!`); }
    else if (T.role === 'fugitive' && !T.s.escaped) { T.s.escaped = true; U.sys(room, `🏃 ${T.name}님이 처형을 피해 도망쳤습니다! (이제 투표할 수 없습니다)`); }
    else {
      U.io.kill(room, T, '투표로 처형되었습니다.');
      if (T.role === 'terrorist') { room.lastBoom = T.id; room.lastPick = null; } // 서버가 '마지막 선택' 시간을 열어 준다
    }
  } else {
    U.sys(room, entries.length ? '⚖️ 동률이라 아무도 처형되지 않았습니다.' : '⚖️ 아무도 처형되지 않았습니다.');
  }

  // ---- 마담: 투표한 사람을 유혹
  for (const { madam, target } of madamVotes) {
    if (!madam.alive || target === madam) continue;
    target.s.blockNight = day + 1;
    if (U.isMafiaKnown(target)) U.contact(room, madam, target);
    U.touch(room, madam, target);
  }
  // ---- 밀고자 / 탐정
  for (const { p, t } of abil) {
    if (p.role === 'informant') {
      U.touch(room, p, t);
      if (U.isMafiaKnown(t)) {
        U.contact(room, p, t);
        const police = room.players.filter((x) => x.role === 'police');
        const doctor = room.players.filter((x) => x.role === 'doctor');
        p.s.known = p.s.known || {};
        for (const x of police) p.s.known[x.id] = 'police';
        for (const x of doctor) p.s.known[x.id] = 'doctor';
        U.priv(room, p, `📢 밀고 성공! 경찰: ${U.names(police) || '없음'} / 의사: ${U.names(doctor) || '없음'}`);
      } else U.priv(room, p, `📢 ${t.name}님은 마피아가 아니었습니다.`);
    } else if (p.role === 'detective' && p.s.detA) {
      const a = U.byId(room, p.s.detA);
      if (a) {
        U.touch(room, p, t);
        const same = U.shownTeam(a) === U.shownTeam(t);
        U.priv(room, p, `🕵 비교 결과: ${a.name}님과 ${t.name}님은 ${same ? '같은 팀입니다.' : '다른 팀입니다.'}`);
      }
    }
  }
  for (const p of room.players) { if (p.s) p.s.detA = null; }
  room.voteActs = {};
  room.votes = {};
  checkAssassins(room);

  // 혁명가: 4일차 낮까지 아무도 능력을 쓰지 않았다면 단독 우승
  if (day >= 4) {
    const rev = room.players.find((x) => x.alive && x.role === 'revolutionary' && !x.s.joined);
    if (rev && !room.pendingWin) room.pendingWin = { kind: 'solo', ids: [rev.id], text: `✊ 혁명가 ${rev.name}님이 혼자 우승했습니다!` };
  }
}

// 승패 판정: 끝났으면 { kind, text, ids }, 아니면 null
//  시민 팀: 마피아 팀과 중립 팀이 모두 사라지면 승
//  마피아 팀: 시민 팀+중립 팀 인원이 마피아 팀 인원 이하가 되면 승
//  중립 팀: 자신을 제외한 모두가 사라지면 승 (거지·부자·혁명가는 각자의 추가 조건이 있음)
// 처형된 테러리스트가 고른 사람과 함께 자폭 (고르지 않으면 아무도 죽지 않는다)
function resolveBoom(room, targetId) {
  const T = U.byId(room, room.lastBoom);
  room.lastBoom = null; room.lastPick = null;
  const victim = targetId ? U.byId(room, targetId) : null;
  if (!T || !victim || !victim.alive || victim === T) { U.sys(room, '💣 테러리스트는 아무도 데려가지 않았습니다.'); return; }
  U.io.kill(room, victim, '테러리스트의 자폭에 휘말려 사망했습니다.');
}

function checkWin(room) {
  if (room.pendingWin) { const w = room.pendingWin; room.pendingWin = null; return w; }
  const alive = U.alive(room);
  if (!alive.length) return { kind: 'draw', text: '🤝 모두 사망하여 무승부입니다.', ids: [] };
  const M = alive.filter((p) => U.teamOf(p) === 'mafia').length;
  const C = alive.filter((p) => U.teamOf(p) === 'citizen').length;
  const N = alive.filter((p) => U.teamOf(p) === 'neutral');
  const ids = (t) => room.players.filter((p) => U.teamOf(p) === t).map((p) => p.id);
  if (M > 0 && M >= alive.length - M) return { kind: 'mafia', text: '🔪 마피아 팀이 승리했습니다!', ids: ids('mafia') };
  // 짝(부자/거지)이 죽어서 더는 이길 수 없는 거지·부자는 시민 승리를 막지 않는다
  const hasRole = (r) => alive.some((p) => p.role === r);
  const threat = N.filter((p) => !((p.role === 'beggar' && !hasRole('rich')) || (p.role === 'rich' && !hasRole('beggar'))));
  if (M === 0 && threat.length === 0 && C > 0) return { kind: 'citizen', text: '🎉 시민 팀이 승리했습니다!', ids: ids('citizen') };
  if (alive.length === 1 && N.length === 1) {
    return { kind: 'neutral', text: `🌀 중립 팀 ${N[0].name}님(${U.roleName(N[0].role)})이 끝까지 살아남아 우승했습니다!`, ids: [N[0].id] };
  }
  // 중립만 2명 이상 남았는데 아무도 죽일 수 없으면 무승부
  if (M === 0 && C === 0 && N.length > 1 && !N.some((p) => p.role === 'madman' || p.role === 'destroyer')) {
    return { kind: 'draw', text: '🤝 승부가 나지 않아 무승부입니다.', ids: [] };
  }
  return null;
}

module.exports = { resolveVote, resolveBoom, checkWin, weight };
