'use strict';
// 내기꾼의 가위바위보: 밤이 끝나면 대결이 열리고(rps 단계), 7초 안에 내지 않은 쪽이 진다.
const U = require('./util');
const AB = require('./abilities');

const SIGN = { r: '✊ 바위', p: '✋ 보', s: '✌️ 가위' };
const BEATS = { r: 's', s: 'p', p: 'r' }; // key 가 value 를 이긴다

// 이번 밤에 열릴 대결 목록 (한 사람은 한 대결에만 들어간다)
function rpsMatches(room) {
  const out = [], used = new Set();
  for (const b of U.alive(room)) {
    if (b.role !== 'bettor') continue;
    const a = room.night && room.night.acts[b.id];
    if (!a || !a.target) continue;
    const opt = AB.nightOptions(room, b);
    if (!opt || !opt.targets.includes(a.target)) continue;
    const t = U.byId(room, a.target);
    if (!t || !t.alive) continue;
    if (used.has(b.id) || used.has(t.id)) { U.priv(room, b, '✊ 상대가 다른 대결 중이라 이번 밤 대결은 열리지 않았어요.'); continue; }
    used.add(b.id); used.add(t.id);
    out.push({ b: b.id, t: t.id, bm: null, tm: null });
  }
  return out;
}

const matchOf = (room, p) => (room.rps && room.rps.matches || []).find((m) => m.b === p.id || m.t === p.id) || null;

// 가위(s)·바위(r)·보(p) 내기. 한 번 내면 바꿀 수 없다.
function rpsPick(room, p, sign) {
  if (room.phase !== 'rps') U.fail('지금은 가위바위보 시간이 아니에요.');
  const m = matchOf(room, p);
  if (!m) U.fail('이번 가위바위보에 참가하지 않았어요.');
  if (!SIGN[sign]) U.fail('가위, 바위, 보 중에서 골라 주세요.');
  const key = m.b === p.id ? 'bm' : 'tm';
  if (m[key]) U.fail('이미 냈어요.');
  m[key] = sign;
}
const rpsDone = (room) => !!room.rps && room.rps.matches.every((m) => m.bm && m.tm);

// 시간이 끝났거나 모두 냈을 때 결과를 정하고 개인 메시지로 알린다
function rpsResolve(room) {
  const need = U.bettorNeed(room);
  for (const m of (room.rps && room.rps.matches) || []) {
    const b = U.byId(room, m.b), t = U.byId(room, m.t);
    if (!b || !t) continue;
    let res; // 'win' | 'lose' | 'tie'
    let why = '';
    if (!m.bm) { res = 'lose'; why = '시간 안에 내지 못했어요.'; }
    else if (!m.tm) { res = 'win'; why = `${t.name}님이 시간 안에 내지 못했어요.`; }
    else if (m.bm === m.tm) res = 'tie';
    else res = BEATS[m.bm] === m.tm ? 'win' : 'lose';
    const sg = (x) => (x ? SIGN[x] : '(안 냄)');
    const sh = `나: ${sg(m.bm)} / 상대: ${sg(m.tm)}`, sh2 = `나: ${sg(m.tm)} / 상대: ${sg(m.bm)}`; // 내기꾼 기준 / 상대 기준
    if (res === 'win') {
      b.s.beaten = (b.s.beaten || []).concat(t.id);
      U.priv(room, b, `✊ 가위바위보 승리! ${t.name}님을 이겼어요. (${sh}) ${why} (${b.s.beaten.length}/${need}명)`);
      U.priv(room, t, `✊ 내기꾼 ${b.name}님에게 가위바위보에서 졌어요. (${sh2}) ${m.tm ? '' : '시간 안에 내지 못했어요.'}`);
    } else if (res === 'lose') {
      U.priv(room, b, `✊ 가위바위보에서 졌어요. (${sh}) ${why} 다음 밤에 다시 도전할 수 있어요.`);
      U.priv(room, t, `✊ 내기꾼 ${b.name}님과의 가위바위보에서 이겼어요! (${sh2}) ${m.bm ? '' : '상대가 시간 안에 내지 못했어요.'}`);
    } else {
      U.priv(room, b, `✊ 비겼어요. (${sh}) 다음 밤에 다시 도전할 수 있어요.`);
      U.priv(room, t, `✊ 내기꾼 ${b.name}님과의 가위바위보에서 비겼어요. (${sh2})`);
    }
  }
  room.rps = null;
}

module.exports = { rpsMatches, rpsPick, rpsDone, rpsResolve, matchOf, SIGN };
