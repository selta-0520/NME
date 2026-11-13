'use strict';
// 투표 처리 + 승리 판정
const { ROLE } = require('../roles');
const U = require('./util');
const AB = require('./abilities');
const { checkAssassins } = require('./night');

const weight = (p) => (p.role === 'politician' ? 2 : 1);

// 투표 집계 (처형은 하지 않음)
function tallyVote(room) {
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
  const leader = entries.length && (entries.length === 1 || entries[0][1] > entries[1][1]) ? U.byId(room, entries[0][0]) : null;
  return { tally, skip, madamVotes, entries, summary, leader };
}
const announceTally = (room, t) => U.sys(room, `🗳 투표 결과: ${t.summary.length ? t.summary.join(', ') : '투표가 없었습니다.'}`);

// 찬반투표 집계: 과반수(찬성이 더 많아야) 처형, 동점이면 무효 (반대와 같음)
function confirmTally(room) {
  let yes = 0, no = 0;
  const T = room.defense && U.byId(room, room.defense.id);
  for (const [pid, c] of Object.entries(room.confirm || {})) {
    const v = U.byId(room, pid);
    if (!v || !v.alive || v === T || !AB.canVote(room, v)) continue;
    const ex = !!(room.extra && room.extra[v.id]); // 능력을 쓰기로 한 경우에만
    if (c === 'yes') yes += v.role === 'prosecutor' && ex ? 2 : weight(v); else if (c === 'no') no += v.role === 'lawyer' && ex ? 2 : weight(v); // 검사: 찬성 2표 / 변호사: 반대 2표
  }
  if (room.judgeVerdict) return { yes, no, ok: room.judgeVerdict.ok, judged: true, judge: room.judgeVerdict.by }; // 판사의 판결이 우선
  return { yes, no, ok: yes > no };
}
const confirmVoters = (room) => {
  if (room.judgeOnly) return []; // 최후의 반론이 꺼진 판: 판사의 판결만 기다리는 짧은 시간
  const T = room.defense && U.byId(room, room.defense.id);
  return U.alive(room).filter((x) => x !== T && AB.canVote(room, x));
};

// opts.defense = { ok }: 최후의 반론 + 찬반투표를 거친 뒤의 처형 (ok 가 아니면 처형 취소). 집계 공지는 이미 했다.
function resolveVote(room, opts) {
  opts = opts || {};
  const day = room.day;
  const { madamVotes, entries, summary, leader } = tallyVote(room);
  if (!opts.defense) U.sys(room, `🗳 투표 결과: ${summary.length ? summary.join(', ') : '투표가 없었습니다.'}`);

  // 투표시간 능력은 처형 전에 상태를 기록해 둔다 (처형으로 죽어도 결과는 전달)
  const forgeList = [];
  const abil = Object.entries(room.voteActs).map(([pid, a]) => ({ p: U.byId(room, pid), t: U.byId(room, a.target) }))
    .filter((x) => x.p && x.p.alive && x.t);

  // ---- 처형
  if (leader && opts.defense && !opts.defense.ok) {
    U.sys(room, `🛑 찬반투표에서 반대가 더 많거나 동점이라 ${leader.name}님의 처형이 무효가 되었습니다.`);
  } else if (leader) {
    const T = leader;
    if (opts.defense) U.sys(room, `⚖️ 찬반투표에서 찬성이 더 많아 ${T.name}님의 처형이 확정되었습니다.`);
    if (T.role === 'politician') U.sys(room, `🏛 정치인 ${T.name}님은 투표로 죽지 않습니다!`);
    else if (T.role === 'beggar' && !T.s.met) U.sys(room, `🙏 거지 ${T.name}님은 투표로 죽지 않습니다!`);
    else if (T.role === 'madman' && U.usesLeft(room, T, 'madman') > 0) { U.useOne(T, 'madman'); U.sys(room, `🌀 ${T.name}님은 처형 투표에서 살아남았습니다!`); }
    else if (T.role === 'fugitive' && !T.s.escaped) { T.s.escaped = true; U.sys(room, `🏃 ${T.name}님이 처형을 피해 도망쳤습니다! (이제 투표할 수 없습니다)`); }
    else if (U.survive(room, T)) U.sys(room, `🍀 ${T.name}님은 처형에서 살아남았습니다!`);
    else {
      U.io.kill(room, T, '투표로 처형되었습니다.');
      if (T.role === 'attention' && !room.pendingWin) room.pendingWin = { kind: 'solo', ids: [T.id], text: `📣 관종 ${T.name}님이 투표로 처형되어 혼자 우승했습니다!` };
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
    } else if (p.role === 'forger' && p.contacted) {
      U.touch(room, p, t); forgeList.push(t);
      U.priv(room, p, `🖋 ${t.name}님의 조사 결과를 위조했습니다. (다음 투표 때까지 유지)`);
    } else if (p.role === 'detective' && p.s.detA) {
      const a = U.byId(room, p.s.detA);
      if (a) {
        U.touch(room, p, t);
        const same = U.shownTeam(a) === U.shownTeam(t);
        U.priv(room, p, `🕵 비교 결과: ${a.name}님과 ${t.name}님은 ${same ? '같은 팀입니다.' : '다른 팀입니다.'}`);
      }
    }
  }
  for (const p of room.players) { if (p.s) { p.s.detA = null; p.s.forged = false; } } // 지난 위조는 끝나고 새 위조가 시작
  for (const t of forgeList) t.s.forged = true;
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
  if (U.survive(room, victim)) { U.sys(room, `💣 테러리스트의 자폭에서 ${victim.name}님이 살아남았습니다!`); return; }
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
  // 신봉자: 주인이 살아있고 주인의 팀이 이기면 함께 우승
  const followersOf = (team) => alive.filter((p) => {
    if (p.role !== 'follower' || !p.s.master) return false;
    const m = U.byId(room, p.s.master);
    return m && m.alive && U.teamOf(m) === team;
  }).map((p) => p.id);
  const fText = (team, base) => { const f = followersOf(team); return f.length ? `${base} (신봉자 ${U.names(f.map((i) => U.byId(room, i)))}님도 함께 우승!)` : base; };
  // 생존자·도둑: 마피아 팀 또는 시민 팀이 전멸했을 때 살아있으면 우승
  const SS = alive.filter((p) => p.role === 'survivor' || p.role === 'thief');
  if (SS.length && (M === 0 || C === 0)) {
    return { kind: 'neutral', text: `🍀 ${M === 0 ? '마피아' : '시민'} 팀이 전멸했습니다! ${SS.map((p) => `${U.roleName(p.role)} ${p.name}님`).join(', ')}이(가) 끝까지 살아남아 우승했습니다!`, ids: SS.map((p) => p.id) };
  }
  if (M > 0 && M >= alive.length - M) return { kind: 'mafia', text: fText('mafia', '🔪 마피아 팀이 승리했습니다!'), ids: ids('mafia').concat(followersOf('mafia')) };
  // 짝(부자/거지)이 죽어서 더는 이길 수 없는 거지·부자, 혼자서는 이길 수 없는 신봉자는 시민 승리를 막지 않는다
  const hasRole = (r) => alive.some((p) => p.role === r);
  const threat = N.filter((p) => p.role !== 'follower' && p.role !== 'prophet' && !((p.role === 'beggar' && !hasRole('rich')) || (p.role === 'rich' && !hasRole('beggar'))));
  if (M === 0 && threat.length === 0 && C > 0) return { kind: 'citizen', text: fText('citizen', '🎉 시민 팀이 승리했습니다!'), ids: ids('citizen').concat(followersOf('citizen')) };
  if (alive.length === 1 && N.length === 1) {
    if (N[0].role === 'follower') return { kind: 'draw', text: '🤝 신봉자만 남아 승부가 나지 않아 무승부입니다.', ids: [] };
    return { kind: 'neutral', text: `🌀 중립 팀 ${N[0].name}님(${U.roleName(N[0].role)})이 끝까지 살아남아 우승했습니다!`, ids: [N[0].id] };
  }
  // 중립만 2명 이상 남았는데 아무도 죽일 수 없으면 무승부
  const killer = (p) => p.role === 'madman' || (p.role === 'destroyer' && (p.s.destroyUsed || 0) < U.destroyLimit(room));
  if (M === 0 && C === 0 && N.length > 1 && !N.some(killer)) {
    return { kind: 'draw', text: '🤝 승부가 나지 않아 무승부입니다.', ids: [] };
  }
  return null;
}

// 예언가: 게임이 끝났을 때 절반 이상 맞혔다면 모든 승리를 취소하고 예언가가 우승 (처음 배정된 직업 기준)
function prophetCheck(room, w) {
  const won = [];
  for (const p of room.players) {
    const borne = p.role === 'prophet' && p.snap; // 광대로 중간에 예언가가 된 경우: 그때 살아 있던 사람들의 그때 직업 기준
    if ((p.origRole !== 'prophet' && !borne) || !p.guess) continue;
    const others = borne ? room.players.filter((x) => x !== p && p.snap.roles[x.id]) : room.players.filter((x) => x !== p);
    if (!others.length) continue;
    const right = others.filter((x) => p.guess[x.id] === (borne ? p.snap.roles[x.id] : x.origRole)).length;
    if (right * 2 >= others.length) won.push({ p, right, total: others.length });
  }
  if (!won.length) return w;
  const txt = won.map((x) => `예언가 ${x.p.name}님(${x.right}/${x.total}명 적중)`).join(', ');
  return { kind: 'prophet', text: `🔮 ${txt}의 예언이 절반 이상 맞았습니다! 모든 승리가 취소되고 예언가가 우승했습니다!`, ids: won.map((x) => x.p.id), was: w };
}

module.exports = { resolveVote, resolveBoom, checkWin, weight, prophetCheck, tallyVote, announceTally, confirmTally, confirmVoters };
