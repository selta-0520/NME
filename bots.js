'use strict';
// 봇 두뇌 (v2). 봇은 사람과 똑같이 handleAction 으로만 행동하고, 남의 직업을 몰래 보지 않습니다.
// 봇이 쓰는 정보:
//   · 내 직업·내 능력 결과(내게 온 개인 메시지)·내가 아는 마피아 팀원
//   · 모두에게 공개된 것: 채팅(사람/봇이 한 말), 사망 공지, 투표 현황의 "득표 수"(누가 누구에게 찍었는지는 모릅니다)
// 추리 방식: 모든 정보를 "의심 점수"로 합칩니다. (경찰 주장의 신뢰도, 거짓말 탐지, 지목·두둔, 침묵, 밤 사건 등)
const crypto = require('crypto');
const { ROLES, ROLE } = require('./roles');
const E = require('./engine');
const { U } = E;

let deps = null;
function init(d) { deps = d; }

// noise: 판단에 섞이는 무작위 / think: 증거를 얼마나 반영하나 / skip: 행동을 빼먹을 확률 / mistake: 마피아의 팀원 오공격
// speak: 말 많은 정도 / consensus: 다수 의견을 따르는 정도 / counter: 가짜 경찰 맞불 / defend: 지목당하면 반박 / intent: 투표 예고
const LEVELS = {
  easy:    { noise: 48, think: 0.2,  skip: 0.2,  mistake: 0.15, speak: 0.45, consensus: 0.1,  coord: false, counter: false, fake: false, defend: 0.4,  intent: 0.3, sacrifice: false, hunt: false, once: 0.35, band: 4, wise: 0 },
  normal:  { noise: 22, think: 0.6,  skip: 0.05, mistake: 0.05, speak: 0.7,  consensus: 0.5,  coord: true,  counter: false, fake: true,  defend: 0.8,  intent: 0.6, sacrifice: false, hunt: true,  once: 0.5,  band: 7, wise: 0.3 },
  hard:    { noise: 9,  think: 0.9,  skip: 0.01, mistake: 0,    speak: 0.85, consensus: 0.8,  coord: true,  counter: true,  fake: true,  defend: 0.95, intent: 0.8, sacrifice: false, hunt: true,  once: 0.6,  band: 8, wise: 0.75 },
  extreme: { noise: 3,  think: 1,    skip: 0,    mistake: 0,    speak: 0.95, consensus: 0.93, coord: true,  counter: true,  fake: true,  defend: 1,    intent: 0.9, sacrifice: true,  hunt: true,  once: 0.7,  band: 9, wise: 1 },
};
const LEVEL_KEYS = Object.keys(LEVELS);
// 봇 성격(판마다 무작위): talk = 말 많은 정도, sus = 의심을 입 밖에 내는 문턱(클수록 쉽게 지목)
const PERSONAS = [{ talk: 1.5, sus: 0 }, { talk: 0.55, sus: 0 }, { talk: 1, sus: 5 }, { talk: 0.9, sus: -4 }];
const persona = (p) => { const b = pm(p); if (!b.persona) b.persona = PERSONAS[crypto.randomInt(PERSONAS.length)]; return b.persona; };
const FILLERS = ['안녕하세요! 다들 잘 부탁해요.', '아직은 단서가 없네요. 의견 좀 들어봐요.', '어제 밤에 무슨 일이 있었죠?', '조용한 사람이 신경 쓰이네요.', '투표는 신중하게 해요.', '일단 지켜볼게요.', '의심 가는 사람 있어요?'];
const ONCE = new Set(['reporter', 'priest', 'angel', 'scientist']);
const effRole = (p) => (p.role === 'thief' && p.s.loan ? p.s.loan : p.role); // 도둑은 훔친 능력의 직업처럼 행동
const ROLE_BY_NAME = {}; for (const r of ROLES) ROLE_BY_NAME[r.name] = r.key;
const CLAIMABLE = ['police', 'doctor', 'soldier', 'politician', 'bodyguard', 'detective', 'reporter', 'medium'];

const rnd = (a) => a[crypto.randomInt(a.length)];
const chance = (p) => Math.random() < p;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// 봇마다 난이도를 따로 줄 수 있다 (p.lvl, 시험용). 없으면 방 설정을 따른다.
const lv = (room, p) => LEVELS[(p && p.lvl) || room.settings.botLevel] || LEVELS.normal;
const names = (list) => list.map((x) => x.name).join(', ');
// 반응 지연: 낮 시간의 몇 %로 정한다 (낮이 90초면 대략 2~5초)
const delayMs = (room, a, b) => Math.max(400, (a + Math.random() * (b - a)) * (room.settings.daySec || 60) * 1000);
function act(room, p, body) { try { deps.handleAction(room, p, body); return true; } catch (e) { return false; } }
const byName = (room, n) => room.players.find((x) => x.name === n);
const aliveBots = (room) => room.players.filter((x) => x.bot && x.alive);

// ------------------------------------------------------------ 기억
function ai(room) {
  if (!room.ai) room.ai = { claims: [], res: [], acc: [], vouch: [], intent: {}, dead: {}, pubRole: {}, talk: {}, lastMsgId: 0, fail: {}, tried: {}, plan: {}, healedDay: -9, lastKill: null, said: {}, n: 0, vrec: {} };
  return room.ai;
}
function pm(p) {
  if (!p.ai) p.ai = { checks: {}, known: {}, hint: {}, pending: null, lastPriv: 0, announced: {}, replied: {}, spoke: {}, lastSay: 0, lastTop: null, detA: null, fakeDay: 0, claimed: {} };
  return p.ai;
}
function reset(room) { room.ai = null; for (const p of room.players) p.ai = null; }

// 공개 정보 읽기: 모두가 보는 공지(sys)에서 단서를 뽑는다
function syncSys(room) {
  const A = ai(room);
  const fresh = room.chat.filter((m) => m.id > A.lastMsgId);
  for (const m of fresh) {
    A.lastMsgId = Math.max(A.lastMsgId, m.id);
    if (m.ch !== 'sys') continue;
    const t = m.text;
    let r;
    if (t.startsWith('🩺 마피아의 습격')) A.healedDay = room.day;
    else if ((r = /^📰 속보! (.+?)님의 직업은 "(.+?)"입니다/.exec(t))) { const q = byName(room, r[1]); if (q && ROLE_BY_NAME[r[2]]) A.pubRole[q.id] = ROLE_BY_NAME[r[2]]; }
    else if ((r = /^🏛 정치인 (.+?)님은/.exec(t))) { const q = byName(room, r[1]); if (q) A.pubRole[q.id] = 'politician'; }
    else if ((r = /^🌀 (.+?)님은 처형 투표에서/.exec(t))) { const q = byName(room, r[1]); if (q) A.pubRole[q.id] = 'madman'; }
    else if ((r = /^🛡 경호원 (.+?)님이 (.+?)님 대신 공격을 받았습니다! 공격한 사람은 (.+?)님입니다/.exec(t))) {
      const by = byName(room, r[3]); if (by) A.exposed = (A.exposed || {}), A.exposed[by.id] = (A.exposed[by.id] || 0) + 1;
    } else if (t.startsWith('🃏')) { A.claims = []; A.res = []; A.acc = []; A.vouch = []; A.intent = {}; for (const q of room.players) if (q.ai) { q.ai.checks = {}; q.ai.known = {}; q.ai.hint = {}; } }
    else if ((r = /^📜 섞이기 전의 원래 직업: (.+)$/.exec(t))) { /* 직업이 모두 바뀌었으니 예전 정보는 버린다 (위에서 이미 초기화) */ }
  }
}
// 내게 온 개인 메시지에서 능력 결과를 읽는다
function syncPriv(room, p) {
  const b = pm(p);
  for (const m of room.chat) {
    if (m.ch !== 'priv' || m.to !== p.id || m.id <= b.lastPriv) continue;
    b.lastPriv = m.id;
    const t = m.text; let r;
    if ((r = /^🔍 조사 결과: (.+?)님은 (마피아입니다|마피아가 아닙니다)/.exec(t))) { const q = byName(room, r[1]); if (q) { b.checks[q.id] = r[2] === '마피아입니다' ? 'mafia' : 'clean'; if (b.checks[q.id] === 'mafia') b.announced[q.id] = false; } }
    else if ((r = /^🕵 조사 결과: (.+?)님의 직업은 "(.+?)"입니다/.exec(t))) {
      const q = byName(room, r[1]), k = ROLE_BY_NAME[r[2]];
      if (q && k) { b.known[q.id] = k; if (ROLE[k].team === 'mafia') b.checks[q.id] = 'mafia'; }
    } else if ((r = /^🕵 비교 결과: (.+?)님과 (.+?)님은 (같은 팀|다른 팀)/.exec(t))) {
      const a = byName(room, r[1]), c = byName(room, r[2]);
      if (a && c) {
        const ref = b.detA === a.id ? c : a, tgt = ref === c ? a : c; // 밤에 고른 사람이 tgt
        const refClean = b.checks[ref.id] === 'clean' || b.known[ref.id] === 'citizen';
        const same = r[3] === '같은 팀';
        if (same) b.hint[tgt.id] = (b.hint[tgt.id] || 0) - (refClean ? 140 : 40); else b.hint[tgt.id] = (b.hint[tgt.id] || 0) + (refClean ? 130 : 30);
      }
    } else if ((r = /^🔮 성불 결과: (.+?)님의 직업은 "(.+?)"였습니다/.exec(t))) { const q = byName(room, r[1]), k = ROLE_BY_NAME[r[2]]; if (q && k) b.known[q.id] = k; }
    else if ((r = /^📨 메시지를 보낸 (.+?)님이 사망했습니다. 진짜 직업은 "(.+?)"였습니다/.exec(t))) { const q = byName(room, r[1]), k = ROLE_BY_NAME[r[2]]; if (q && k) b.known[q.id] = k; }
    else if ((r = /^📢 밀고 성공! 경찰: (.*?) \/ 의사: (.*)$/.exec(t))) {
      for (const n of r[1].split(', ')) { const q = byName(room, n); if (q) b.known[q.id] = 'police'; }
      for (const n of r[2].split(', ')) { const q = byName(room, n); if (q) b.known[q.id] = 'doctor'; }
    } else if ((r = /^📢 (.+?)님은 마피아가 아니었습니다/.exec(t))) { const q = byName(room, r[1]); if (q) b.checks[q.id] = 'clean'; }
    else if (t.startsWith('🕵 스파이') || t.startsWith('⚠ 군인')) { /* 군인 관련 알림 */ }
    else if ((r = /^🛡 지키던 (.+?)님이 사망했습니다/.exec(t))) { /* 경호원 알림: 공개 공지에서 처리 */ }
  }
}
function sync(room, p) { syncSys(room); if (p) syncPriv(room, p); }

// ------------------------------------------------------------ 추리
const publicRole = (room, id) => ai(room).pubRole[id] || null;
// 내가 팀원으로 아는 사람 (접선한 마피아 팀끼리, 접선한 밀고자는 명단을 안다)
function knownMate(me, c) { return c !== me && (U.inMafiaChat(me) || (me.role === 'informant' && me.contacted)) && U.inMafiaChat(c); }
const mafiaSide = (me) => U.teamOf(me) === 'mafia';
function claimants(room, role) { const out = []; for (const c of ai(room).claims) if (c.role === role && !out.includes(c.by)) out.push(c.by); return out; }
function claimedRole(room, id, role) { return ai(room).claims.some((c) => c.by === id && c.role === role); }

// 공개 주장을 한 사람이 얼마나 믿을 만한가 (0~1)
function cred(room, me, by, role) {
  const A = ai(room), q = U.byId(room, by); if (!q) return 0;
  if (by === me.id) return 1;
  if (knownMate(me, q)) return 0;
  const pr = publicRole(room, by); if (pr) return pr === role ? 1 : 0;
  const b = pm(me); if (b.known[by]) return b.known[by] === role ? 1 : 0;
  const list = claimants(room, role), rank = list.indexOf(by);
  if (rank < 0) return 0.5;
  let w = list.length <= 1 ? 0.88 : 1 / list.length; // 주장이 둘 이상이면 진짜는 많아야 한 명: 어느 쪽이 진짜인지는 반반
  const d = A.dead[by];
  if (d && d.phase === 'night' && d.how === 'mafia') w = Math.max(w, 0.95); // 마피아가 노릴 만큼 위협적이었다
  else if (!d) for (const o of list) { const od = A.dead[o]; if (o !== by && od && od.phase === 'night' && od.how === 'mafia') w = Math.min(w, 0.15); } // 진짜가 죽고 남은 쪽은 가짜일 확률이 높다
  if (me.role === role && by !== me.id) w = roleCapMulti(room, role) ? Math.min(w, 0.4) : 0; // 내가 그 직업인데 남이 주장하면 거짓말
  return w;
}
const roleCapMulti = (room, role) => ((room.settings.roleMax && room.settings.roleMax[role]) || 1) > 1;

// 물타기 판별: 이 지목은 내가 먼저 지목당한 뒤 맞받아친 것인가 (같은 날, 근거 없이)
function isRetaliation(A, a) { return A.acc.some((a1) => a1.target === a.by && a1.by !== a.by && a1.n < a.n && a1.day === a.day); }
// 이 사람이 마피아일 가능성 점수 (높을수록 의심, 내가 확실히 아는 팀원은 -1000)
function sus(room, me, c, o) {
  o = o || {};
  const L = lv(room, me), A = ai(room), b = pm(me), T = L.think;
  if (c === me || knownMate(me, c)) return -1000;
  if (b.checks[c.id] === 'mafia') return 1000;
  const social = !o.noSocial;
  let s = b.hint[c.id] || 0;
  if (b.checks[c.id] === 'clean') s -= 250;
  const kr = b.known[c.id];
  if (kr) s += ROLE[kr].team === 'mafia' ? 400 : -150;
  const pr = publicRole(room, c.id);
  if (pr) s += ROLE[pr].team === 'mafia' ? 400 : ROLE[pr].team === 'citizen' ? -150 : 0;
  // 경찰 조사 주장
  for (const r of A.res) {
    if (r.target !== c.id || r.by === me.id) continue;
    const by = U.byId(room, r.by); if (!by) continue;
    let w = cred(room, me, r.by, 'police');
    const mine = b.checks[r.target]; if (mine) w = mine === r.res ? Math.max(w, 0.9) : 0; // 내 조사와 같으면 신뢰, 다르면 거짓말
    if (mafiaSide(me) && knownMate(me, by)) continue;
    s += (r.res === 'mafia' ? 170 : -110) * w * T;
  }
  // 직업을 공개 주장한 사람: 같은 직업 주장이 둘 이상이면 서로 의심스럽다
  for (const role of CLAIMABLE) {
    if (!claimedRole(room, c.id, role)) continue;
    const w = cred(room, me, c.id, role);
    s += (0.55 - w) * 90 * T;
    if (role === 'police' && claimants(room, role).length >= 2 && w < 0.9) s += 60 * T; // 경찰이 둘 이상 → 한 명은 가짜(마피아 쪽)
  }
  // ---- 여기까지가 "근거"(조사 결과·직업 주장·드러난 행동). 아래는 "분위기"(지목·예고·표 쏠림)
  const W = L.wise || 0;
  let soc = 0; // 분위기 점수: 몰이에 휩쓸리지 않도록 마지막에 상한을 둔다
  // 지목/두둔: 믿을 만한 사람의 지목일수록 무게가 크다 (의심스러운 사람의 지목은 별로 안 믿는다)
  const accusers = new Set();
  for (const a of A.acc) {
    if (a.target === c.id && a.by !== me.id && a.by !== c.id) {
      const q = U.byId(room, a.by);
      if (q && q.alive && !accusers.has(a.by)) {
        accusers.add(a.by);
        if (social) { const w = clamp(1 - sus(room, me, q, { noSocial: true }) / 120, 0.2, 2); const rt = !a.ev && isRetaliation(A, a) ? 0.2 : 1; soc += (b.checks[a.by] === 'mafia' ? -10 : knownMate(me, q) ? 0 : 6 * w * rt * (a.ev ? 1.6 : 1 - 0.35 * W)) * T; }
      } else if (q && !q.alive && A.dead[a.by] && A.dead[a.by].phase === 'night' && social) soc += 8 * T; // 밤에 죽은 사람이 의심하던 사람
    }
    if (a.by === c.id) {
      const bad = (b.checks[a.target] === 'clean') || (A.res.some((r) => r.target === a.target && r.res === 'clean' && cred(room, me, r.by, 'police') > 0.6));
      const good = (b.checks[a.target] === 'mafia') || (A.res.some((r) => r.target === a.target && r.res === 'mafia' && cred(room, me, r.by, 'police') > 0.6));
      if (bad) s += 14 * T; if (good) s -= 14 * T;
    }
  }
  if (social) { // 근거 없이 남을 몰아가는 사람은 수상하다 (마피아가 무고한 사람을 몰아갈 때 흔한 모습)
    let base = 0; const seen = new Set();
    for (const a of A.acc) {
      if (a.by !== c.id || seen.has(a.target) || a.target === me.id) continue;
      seen.add(a.target);
      const t = U.byId(room, a.target); if (!t || !t.alive) continue;
      if (b.checks[t.id] === 'mafia' || knownMate(me, t)) continue;
      if (sus(room, me, t, { noSocial: true }) < 10 && !(A.res.some((r) => r.by === c.id && r.target === t.id)) && !a.ev) base++;
    }
    s += Math.min(base, 3 + Math.round(W)) * (7 + 3 * W) * T;
  }
  if (social) { // 물타기: 지목당한 뒤 근거 없이 맞받아 몰아가는 사람
    let defl = 0;
    for (const a2 of A.acc) {
      if (a2.by !== c.id || a2.ev || a2.target === me.id) continue;
      const hit = A.acc.find((a1) => a1.by !== c.id && a1.target === c.id && a1.n < a2.n && a1.day === a2.day);
      if (!hit) continue;
      const t2 = U.byId(room, a2.target); if (!t2 || !t2.alive || knownMate(me, t2) || b.checks[t2.id] === 'mafia') continue;
      defl += (a2.target === hit.by ? 1 : 0.6) * (hit.ev ? 0.4 : 1);
    }
    s += Math.min(defl, 2) * 16 * (0.5 + W) * T;
  }
  if (social && W > 0) { // 지난 투표 기록: 무고한 사람 처형을 밀었던 사람 / 마피아를 잡아낸 사람
    const v = A.vrec[c.id];
    if (v) s += (v.wrong * 8 - v.right * 11) * W * T;
  }
  for (const v of A.vouch) {
    if (v.by !== c.id) continue;
    const t = U.byId(room, v.target);
    if (t && (b.checks[t.id] === 'mafia' || (A.exposed && A.exposed[t.id]))) s += 16 * T;
  }
  if (A.exposed && A.exposed[c.id]) s += 200 * T; // 경호원 덕분에 공격한 사람으로 드러남
  if (!social) return s;
  if (room.day >= 2 && !(A.talk[c.id] > 0) && c.alive) s += 5 * T; // 계속 말이 없는 사람
  // 투표 흐름
  if (o.tally && o.tally[c.id]) soc += o.tally[c.id] * L.band * T;
  let ic = 0;
  for (const [id, v] of Object.entries(A.intent)) if (v.t === c.id && v.day === room.day && id !== me.id && id !== c.id) ic++;
  soc += ic * 7 * T;
  // 선동 방어: 근거 없이 분위기만으로 쌓인 점수는 상한을 둔다 (근거가 있으면 상한이 올라간다)
  if (W > 0 && soc > 0) soc = Math.min(soc, (34 - 12 * W) + Math.max(0, s) * 0.45);
  return s + soc;
}
// 공개 정보만으로 본 "마을의 의심"
function townView(room, me, c) { return sus(room, me, c); }

// 투표로 처형할 수 없다는 게 알려진 사람
const immune = (room, c) => publicRole(room, c.id) === 'politician' || U.voteImmune(room, c);

// ------------------------------------------------------------ 밤: 대상 고르기
function best(cands, fn, noise) {
  let bs = -1e9, bc = [];
  for (const c of cands) { const v = fn(c) + Math.random() * noise; if (v > bs + 1e-9) { bs = v; bc = [c]; } else if (Math.abs(v - bs) <= 1e-9) bc.push(c); }
  return bc.length ? rnd(bc) : null;
}
// 마피아 팀이 노릴 만한 가치
function killValue(room, me, c) {
  const A = ai(room), L = lv(room, me);
  let v = 0;
  const pc = claimedRole(room, c.id, 'police') ? cred(room, me, c.id, 'police') : 0;
  v += 200 * pc;
  if (claimedRole(room, c.id, 'doctor')) v += 90;
  if (claimedRole(room, c.id, 'detective') || claimedRole(room, c.id, 'bodyguard')) v += 40;
  const b = pm(me);
  if (b.known[c.id] === 'police' || b.known[c.id] === 'doctor') v += 120;
  for (const a of A.acc) if (a.by === c.id) { const t = U.byId(room, a.target); if (t && (knownMate(me, t) || t === me)) v += 45; }
  for (const r of A.res) if (r.by === c.id && r.res === 'mafia') { const t = U.byId(room, r.target); if (t && (knownMate(me, t) || t === me)) v += 120; }
  v -= sus(room, me, c) * (L.think >= 0.9 ? 0.2 : 0.1); // 마을이 믿는 사람일수록 위협적
  v -= (A.fail[c.id] || 0) * 120;
  if (A.healedDay === room.day - 1 && A.lastKill === c.id) v -= 40;
  if (publicRole(room, c.id) && ROLE[publicRole(room, c.id)].team === 'neutral') v -= 20;
  return v;
}

function pickNight(room, p, opt, mode) {
  const L = lv(room, p), A = ai(room), b = pm(p);
  const cands = opt.targets.map((id) => U.byId(room, id)).filter(Boolean);
  if (!cands.length) return null;
  const role = effRole(p), team = U.teamOf(p), N = L.noise;
  const S = (c) => sus(room, p, c);
  const trust = (c) => -S(c);

  if (U.canAttackAsMafia(room, p)) {
    if (L.coord) { // 이미 팀원이 고른 대상이 있으면 따라간다
      const picks = Object.entries(room.night.acts).filter(([pid, a]) => a.target && pid !== p.id && U.byId(room, pid) && U.canAttackAsMafia(room, U.byId(room, pid))).map(([, a]) => a.target).filter((t) => opt.targets.includes(t));
      if (picks.length) return rnd(picks);
    }
    const pool = chance(L.mistake) ? cands : cands.filter((c) => !knownMate(p, c));
    const c = best(pool.length ? pool : cands, (x) => killValue(room, p, x), N * 2);
    return c && c.id;
  }
  switch (role) {
    case 'police': return (best(cands, (c) => (b.checks[c.id] ? -2000 : 0) + S(c), N) || {}).id;
    case 'spy': return (best(cands, (c) => (b.checks[c.id] || b.known[c.id] ? -2000 : 0) + (claimedRole(room, c.id, 'police') || claimedRole(room, c.id, 'doctor') ? 90 : 0) + trust(c) * 0.1, N) || {}).id;
    case 'detective': case 'inspector': return (best(cands, (c) => S(c), N) || {}).id;
    case 'doctor': {
      const credPolice = (c) => (claimedRole(room, c.id, 'police') ? cred(room, p, c.id, 'police') : 0);
      return (best(cands, (c) => credPolice(c) * 160 + (c.id === p.id ? 25 : 0) + trust(c) * 0.12 + (b.checks[c.id] === 'clean' ? 25 : 0), N) || {}).id;
    }
    case 'bodyguard': {
      return (best(cands, (c) => (claimedRole(room, c.id, 'police') ? cred(room, p, c.id, 'police') * 160 : 0) + (claimedRole(room, c.id, 'doctor') ? 60 : 0) + trust(c) * 0.12, N) || {}).id;
    }
    case 'rich': { // 거지는 말도 투표도 못 한다: 조용한 사람부터
      return (best(cands, (c) => (b.checks[c.id] ? -500 : 0) + (A.talk[c.id] > 0 ? -25 * Math.min(A.talk[c.id], 4) : 40), N) || {}).id;
    }
    case 'thug': case 'terrorist': case 'ninja': return (best(cands, (c) => S(c), N) || {}).id;
    case 'ghost': case 'doppelganger': { // 마피아 팀 보조: 팀원은 피하고 위협적인 사람
      const pool = cands.filter((c) => !knownMate(p, c));
      if (role === 'doppelganger') return (best(pool.length ? pool : cands, (c) => trust(c), N) || {}).id;
      return (best(pool.length ? pool : cands, (c) => killValue(room, p, c), N * 2) || {}).id;
    }
    case 'guardian': return (best(cands, (c) => -S(c), N) || {}).id;
    case 'witness': case 'executor': return (best(cands, (c) => S(c), N) || {}).id;
    case 'assassin': { const pool = cands.filter((c) => !knownMate(p, c)); return (best(pool.length ? pool : cands, (c) => killValue(room, p, c), N * 2) || {}).id; }
    case 'destroyer': return (best(cands, (c) => (claimedRole(room, c.id, 'police') ? 150 : 0) + (claimedRole(room, c.id, 'doctor') ? 80 : 0) + trust(c) * 0.15, N * 2) || {}).id;
    case 'medium': return (best(cands, (c) => (A.dead[c.id] && A.dead[c.id].phase === 'vote' ? 30 : 0) + (b.known[c.id] ? -100 : 0), N * 2) || {}).id;
    case 'priest': return (best(cands, (c) => (A.dead[c.id] && A.dead[c.id].how === 'mafia' ? 100 : -40) + (claimedRole(room, c.id, 'police') ? 80 : 0) + (claimedRole(room, c.id, 'doctor') ? 50 : 0), N) || {}).id;
    case 'reporter': return (best(cands, (c) => S(c), N) || {}).id;
    case 'volunteer': return (best(cands, (c) => trust(c) + (claimedRole(room, c.id, 'police') ? 40 : 0), N) || {}).id;
    case 'scientist': {
      if (mode === 'kill') return (best(cands, (c) => S(c), N) || {}).id;
      return (best(cands, (c) => (claimedRole(room, c.id, 'police') ? cred(room, p, c.id, 'police') * 140 : 0) + (c.id === p.id ? 20 : 0) + trust(c) * 0.1, N) || {}).id;
    }
    case 'angel': // 사제: 위협적인 진짜(처럼 보이는) 경찰·의사, 아니면 자신
      return (best(cands, (c) => (claimedRole(room, c.id, 'police') ? cred(room, p, c.id, 'police') * 160 : 0) + (claimedRole(room, c.id, 'doctor') ? 60 : 0) + (c.id === p.id ? 30 : 0) + trust(c) * 0.12, N) || {}).id;
    case 'forger': case 'agitator': case 'poisoner': case 'evil': { // 접선 전: 마피아를 찾는 탐색 (이미 확인한 사람은 제외)
      const pool = cands.filter((c) => !b.checks[c.id] && !knownMate(p, c));
      const pick = rnd(pool.length ? pool : cands);
      if (pick && !b.checks[pick.id]) b.checks[pick.id] = 'tried';
      return (pick || {}).id;
    }
    case 'gambler': // 마피아가 노릴 만한 사람(경찰·의사로 믿음직한 사람)을 예측
      return (best(cands, (c) => (claimedRole(room, c.id, 'police') ? 120 : 0) + (claimedRole(room, c.id, 'doctor') ? 80 : 0) + (claimedRole(room, c.id, 'bodyguard') ? 40 : 0) + trust(c) * 0.15, N * 2) || {}).id;
    case 'thief': // 훔칠 사람: 능력이 있을 것 같은(경찰·의사로 주장한) 사람, 한 번 고른 사람은 제외됨
      return (best(cands, (c) => (claimedRole(room, c.id, 'police') ? 120 : 0) + (claimedRole(room, c.id, 'doctor') ? 90 : 0) + (claimedRole(room, c.id, 'bodyguard') ? 40 : 0) + (A.talk[c.id] > 0 ? 10 : 0), N * 2) || {}).id;
    default: return rnd(cands).id;
  }
}

// 1회용 능력은 쓸 만한 때에만 쓴다
function worthUsing(room, p, opt) {
  const L = lv(room, p), A = ai(room);
  if (!chance(L.once)) return false;
  if (effRole(p) === 'priest') return room.players.some((x) => !x.alive && !x.destroyed && A.dead[x.id] && A.dead[x.id].how === 'mafia');
  if (effRole(p) === 'angel') return true;
  if (effRole(p) === 'scientist') return room.day >= 2;
  return true;
}
function chooseMode(room, p, opt) {
  const A = ai(room), b = pm(p);
  const has = (k) => opt.modes.some((x) => x.key === k);
  if (effRole(p) === 'scientist') {
    const topSus = Math.max(...U.alive(room).filter((x) => x !== p).map((x) => sus(room, p, x)), -1000);
    if (topSus >= 150 && has('kill')) return 'kill';
    return has('heal') ? 'heal' : opt.modes[0].key;
  }
  return opt.mode;
}

function botNight(room, p) {
  const L = lv(room, p);
  sync(room, p);
  if (p.role === 'prophet' && room.day === 1 && !p.guess) { // 예언가: 첫날 밤에 모두의 직업을 예상
    const en = room.settings.enabledRoles.filter((k) => k !== 'rich' && ROLE[k]);
    const guesses = {};
    for (const x of room.players) {
      if (x === p) continue;
      const r = Math.random();
      guesses[x.id] = r < 0.4 && en.includes('citizen') ? 'citizen' : r < 0.55 && en.includes('mafia') ? 'mafia' : rnd(en);
    }
    act(room, p, { type: 'predict', guesses });
    return;
  }
  if (p.role === 'agitator' && p.contacted && U.usesLeft(room, p, 'agitator') > 0) { // 선동가: 믿음직한 사람을 "마피아"로 속여 공개
    const o2 = E.AB.nightOptions(room, p);
    if (o2 && o2.targets.length && !chance(L.skip)) {
      const cs = o2.targets.map((id) => U.byId(room, id)).filter(Boolean);
      const c = best(cs, (x) => (claimedRole(room, x.id, 'police') ? 120 : 0) + (claimedRole(room, x.id, 'doctor') ? 80 : 0) - sus(room, p, x) * 0.2, L.noise);
      if (c && (room.day >= 2 || chance(0.3))) act(room, p, { type: 'night', target: c.id, mode: 'mafia' });
    }
    return;
  }
  let opt = E.AB.nightOptions(room, p);
  if (!opt) return;
  if (chance(L.skip)) return;
  if (ONCE.has(effRole(p)) && !worthUsing(room, p, opt)) return;
  if (opt.noTarget) { // 미치광이: 능력을 쓸지 말지
    const n = U.alive(room).length;
    act(room, p, { type: 'night', target: null, mode: chance(n >= 8 ? 0.6 : n >= 5 ? 0.4 : n >= 4 ? 0.25 : 0.1) ? 'on' : 'off' });
    return;
  }
  let mode = opt.mode;
  if (opt.modes) {
    mode = chooseMode(room, p, opt);
    if (mode !== opt.mode) { act(room, p, { type: 'night', target: null, mode }); opt = E.AB.nightOptions(room, p, mode); if (!opt) return; }
  }
  if (!opt.targets.length) return;
  const id = pickNight(room, p, opt, mode);
  if (!id) return;
  const body = { type: 'night', target: id, mode };
  if (opt.text) body.text = rnd(['누군가 당신을 지켜보고 있어요.', '오늘 낮에 조심하세요.', '당신을 믿어도 될까요?']);
  const ok = act(room, p, body);
  const A = ai(room);
  if (ok && U.canAttackAsMafia(room, p)) { A.tried[room.day] = id; A.lastKill = id; }
  if (ok && p.role === 'detective') pm(p).detA = id;
}

// ------------------------------------------------------------ 말하기
const canSpeak = (room, p) => p.alive && E.chatInfo(room, p).ch === 'all';
const cap = (room) => (U.alive(room).length > 12 ? 3 : 4);
function say(room, p, text, sem) {
  const b = pm(p), A = ai(room);
  if (!canSpeak(room, p)) return false;
  const used = b.spoke[room.day] || 0;
  if (used >= cap(room) + 1) return false;
  if (!act(room, p, { type: 'chat', text })) return false;
  b.spoke[room.day] = used + 1; b.lastSay = Date.now();
  record(room, p, sem || {});
  return true;
}
function record(room, p, sem) {
  const A = ai(room), d = room.day;
  A.talk[p.id] = (A.talk[p.id] || 0) + 1;
  if (sem.claim && !A.claims.some((c) => c.by === p.id && c.role === sem.claim)) A.claims.push({ by: p.id, role: sem.claim, day: d });
  if (sem.res) A.res.push({ by: p.id, target: sem.res.t, res: sem.res.r, day: d });
  if (sem.acc) A.acc.push({ by: p.id, target: sem.acc, day: d, n: ++A.n, ev: !!(sem.res || sem.claim === 'police') });
  if (sem.vouch) A.vouch.push({ by: p.id, target: sem.vouch, day: d });
  if (sem.intent) A.intent[p.id] = { t: sem.intent, day: d };
  react(room);
}

// 가장 의심스러운 사람 (나·팀원·정치인 제외)
function topSuspect(room, p, skipIds) {
  const L = lv(room, p);
  const cands = U.alive(room).filter((x) => x !== p && !knownMate(p, x) && !(skipIds && skipIds.includes(x.id)));
  if (!cands.length) return null;
  return best(cands, (c) => sus(room, p, c), L.noise * 0.5);
}
function reasonFor(room, p, t) {
  const A = ai(room), b = pm(p);
  const polRes = A.res.find((r) => r.target === t.id && r.res === 'mafia' && cred(room, p, r.by, 'police') > 0.5);
  if (polRes) { const by = U.byId(room, polRes.by); return by ? ` 경찰이라는 ${by.name}님의 조사 결과도 있고요.` : ''; }
  if (A.exposed && A.exposed[t.id]) return ' 경호원이 지키던 사람을 공격한 게 드러났잖아요.';
  if (claimedRole(room, t.id, 'police') && claimants(room, 'police').length > 1) return ' 경찰이 둘이라는 건 한 명이 거짓말이라는 뜻이에요.';
  const n = new Set(A.acc.filter((a) => a.target === t.id && a.by !== p.id).map((a) => a.by)).size;
  if (n >= 2) return ' 여러 사람이 의심하고 있어요.';
  if (room.day >= 2 && !(A.talk[t.id] > 0)) return ' 계속 말이 없어요.';
  return '';
}
// 뚜렷한 근거가 없을 때도 이유를 밝힌다 (근거 없이 몰아가는 사람 / 그냥 의심)
function voteReasonFallback(room, p, t) {
  const A = ai(room);
  const base = A.acc.some((a) => a.by === t.id && !a.ev && a.target !== p.id);
  if (base) return ' 근거도 없이 다른 사람을 몰아갔어요.';
  return ' 확실한 근거는 없지만 지금 가장 마음에 걸리는 사람이에요.';
}
function accuseLine(room, p, t) {
  return `${rnd([`${t.name}님이 수상해요.`, `저는 ${t.name}님을 의심해요.`, `${t.name}님 행동이 좀 이상하지 않아요?`])}${reasonFor(room, p, t)}`;
}

// 경찰이 알아낸 결과 공개
function announcePolice(room, p) {
  const b = pm(p);
  const found = Object.keys(b.checks).filter((id) => b.checks[id] === 'mafia' && !b.announced[id] && U.byId(room, id) && U.byId(room, id).alive);
  if (found.length) {
    const t = U.byId(room, found[0]); b.announced[t.id] = true; b.claimed.police = true;
    return say(room, p, `저는 경찰이에요. ${t.name}님을 조사했는데 마피아였어요! ${t.name}님에게 투표해 주세요.`, { claim: 'police', res: { t: t.id, r: 'mafia' }, acc: t.id, intent: t.id });
  }
  return false;
}
// 위협받을 때 경찰이 깨끗한 사람들도 밝힌다
function revealCleans(room, p) {
  const b = pm(p);
  const clean = Object.keys(b.checks).filter((id) => b.checks[id] === 'clean' && U.byId(room, id) && U.byId(room, id).alive);
  if (b.claimed.cleans || !clean.length) return false;
  b.claimed.cleans = true; b.claimed.police = true;
  const list = clean.map((id) => U.byId(room, id));
  const ok = say(room, p, `저는 경찰이에요! 제가 조사한 ${names(list)}님은 마피아가 아니에요. 저를 처형하면 시민이 손해예요.`, { claim: 'police' });
  if (ok) for (const t of list) record(room, p, { res: { t: t.id, r: 'clean' } });
  return ok;
}
// 마피아 팀의 가짜 경찰 (맞불 포함)
function fakePolice(room, p, againstId) {
  const b = pm(p), A = ai(room);
  if (b.fakeDay === room.day || claimedRole(room, p.id, 'police')) return false;
  const pool = U.alive(room).filter((x) => x !== p && !knownMate(p, x));
  if (!pool.length) return false;
  let t = againstId ? U.byId(room, againstId) : null;
  if (!t || !t.alive) t = best(pool, (c) => sus(room, p, c), 6); // 마을이 이미 의심하는 사람을 지목하면 표가 모인다
  if (!t) return false;
  b.fakeDay = room.day;
  const line = againstId ? `제가 진짜 경찰이에요! ${t.name}님이야말로 가짜예요. 저는 ${t.name}님을 조사했는데 마피아가 나왔어요.` : `저는 경찰이에요. ${t.name}님을 조사했는데 마피아였어요!`;
  return say(room, p, line, { claim: 'police', res: { t: t.id, r: 'mafia' }, acc: t.id, intent: t.id });
}
// 진짜 직업 공개(위협받을 때)
function claimRealRole(room, p) {
  const b = pm(p);
  if (b.claimed.role) return false;
  const r = p.role;
  if (!CLAIMABLE.includes(r) || r === 'reporter' || r === 'medium') return false;
  b.claimed.role = true;
  const txt = { police: '저는 경찰이에요.', doctor: '저는 의사예요. 저를 처형하면 치료할 사람이 없어져요.', soldier: '저는 군인이에요. 마피아가 쏴도 한 번은 버텨요.', politician: '저는 정치인이에요. 투표로는 못 죽여요.', bodyguard: '저는 경호원이에요.', detective: '저는 탐정이에요.' }[r];
  return say(room, p, txt, { claim: r });
}
function underFire(room, p) {
  const A = ai(room);
  const n = new Set(A.acc.filter((a) => a.target === p.id && a.by !== p.id && a.day === room.day).map((a) => a.by)).size;
  const tl = tallyOf(room)[p.id] || 0;
  return { acc: n, tally: tl, hot: n >= 2 || tl >= 2 };
}
// 지목당했을 때 반박 (하루에 두 번까지만, 같은 말은 되풀이하지 않는다)
function defend(room, p, accuserId) {
  const L = lv(room, p), b = pm(p), A = ai(room), acc = U.byId(room, accuserId);
  if (!acc || !acc.alive) return false;
  b.replied[accuserId + ':' + room.day] = true;
  b.defCount = b.defCount || {};
  if ((b.defCount[room.day] || 0) >= 2) return false;
  b.defCount[room.day] = (b.defCount[room.day] || 0) + 1;
  const fire = underFire(room, p);
  const policeHit = A.res.find((r) => r.target === p.id && r.res === 'mafia' && r.by === acc.id && claimedRole(room, acc.id, 'police'));
  if (p.role === 'police' && fire.hot && revealCleans(room, p)) return true;
  if (p.role === 'police' && policeHit && acc.id !== p.id && !b.announced['liar' + acc.id]) {
    b.announced['liar' + acc.id] = true; b.claimed.police = true;
    return say(room, p, `제가 진짜 경찰이에요! ${acc.name}님이야말로 가짜예요. 저를 처형하면 마피아만 좋아해요.`, { claim: 'police', acc: acc.id, res: { t: acc.id, r: 'mafia' } });
  }
  // 마피아 팀: 경찰이라는 사람이 나를/팀을 지목하면 가짜 경찰로 맞선다
  if (mafiaSide(p) && L.counter && policeHit && !claimedRole(room, p.id, 'police') && fakePolice(room, p, acc.id)) return true;
  if (mafiaSide(p) && fire.hot && L.fake && chance(0.6) && !claimedRole(room, p.id, 'police') && claimants(room, 'police').length === 0 && fakePolice(room, p)) return true;
  if (fire.hot && !mafiaSide(p) && L.think >= 0.9 && claimRealRole(room, p)) return true;
  const counter = topSuspect(room, p, [acc.id]);
  b.usedLines = b.usedLines || {};
  const lines = [`저는 마피아가 아니에요. ${acc.name}님은 왜 저를 의심하죠?`, `${acc.name}님, 근거가 있나요? 저는 시민이에요.`, `제가 마피아라면 이렇게 가만히 있었겠어요? ${acc.name}님이 더 수상해요.`, `${acc.name}님, 저를 몰아가기 전에 다른 단서부터 따져봐요.`]
    .filter((t) => !b.usedLines[t]);
  let text = lines.length ? rnd(lines) : `${acc.name}님, 저는 아니에요.`;
  b.usedLines[text] = true;
  if (counter && L.think >= 0.7 && chance(0.5)) text += ` 저는 오히려 ${counter.name}님이 신경 쓰여요.`;
  return say(room, p, text, counter && L.think >= 0.7 && text.includes(counter.name) ? { acc: counter.id } : {});
}

// 새 발언이 나올 때마다: 지목당한 봇의 반박, 마피아의 맞불
function react(room) {
  if (room.phase !== 'day' && room.phase !== 'vote') return;
  const A = ai(room), seq = room.seq, L = lv(room);
  for (const p of aliveBots(room)) {
    const b = pm(p), Lp = lv(room, p);
    const hit = A.acc.find((a) => a.target === p.id && a.day === room.day && a.by !== p.id && !b.replied[a.by + ':' + room.day]);
    if (hit && !b.pend) {
      b.pend = true; b.replied[hit.by + ':' + room.day] = 'pending';
      const accuser = hit.by;
      setTimeout(() => {
        b.pend = false;
        if (room.seq !== seq || !deps.rooms.has(room.code) || !p.alive) return;
        try { if (chance(Lp.defend)) defend(room, p, accuser); } catch (e) { console.error('봇 오류', e); }
      }, delayMs(room, 0.02, 0.055));
    }
  }
  { // 경찰 주장이 마피아 팀원을 지목하면 맞불
    const mafias = aliveBots(room).filter((x) => mafiaSide(x) && U.inMafiaChat(x) && lv(room, x).counter);
    if (!mafias.length) return;
    for (const r of A.res) {
      if (r.res !== 'mafia' || r.day !== room.day || A.counterDone && A.counterDone[r.by + ':' + room.day]) continue;
      const by = U.byId(room, r.by), t = U.byId(room, r.target);
      if (!by || !t || !by.alive || !t.alive || mafias.some((m) => m.id === by.id)) continue;
      const hitsTeam = mafias.some((m) => m.id === t.id) || (t.alive && mafias.some((m) => knownMate(m, t)));
      if (!hitsTeam) continue;
      if (mafias.some((m) => claimedRole(room, m.id, 'police'))) continue;
      A.counterDone = A.counterDone || {}; A.counterDone[by.id + ':' + room.day] = true;
      const who = mafias.find((m) => m.id === t.id) || rnd(mafias);
      setTimeout(() => {
        if (room.seq !== seq || !deps.rooms.has(room.code) || !who.alive) return;
        try { fakePolice(room, who, by.id); } catch (e) { console.error('봇 오류', e); }
      }, delayMs(room, 0.025, 0.07));
      break;
    }
  }
}

// 사람이 한 말 읽기
function hear(room, m) {
  const L = lv(room);
  const sp = U.byId(room, m.from); if (!sp || !sp.alive) return;
  const text = m.text, A = ai(room);
  A.talk[sp.id] = (A.talk[sp.id] || 0) + 1;
  if (L.think < 0.5) return;
  const others = room.players.filter((q) => q.id !== sp.id && text.includes(q.name));
  const neg = /아니|않|없/.test(text);
  const accuse = /마피아|의심|수상|범인|처형|죽여|죽이/.test(text) && !(neg && /시민/.test(text));
  const vouch = /시민|믿|무고|확실|안전|깨끗/.test(text);
  const iAm = '(저는|제가|내가|나는|난|저 |전 )';
  const rec = {};
  for (const r of CLAIMABLE) { if (new RegExp(iAm + '\\s*' + ROLE[r].name).test(text)) { rec.claim = r; break; } }
  if (rec.claim && !A.claims.some((c) => c.by === sp.id && c.role === rec.claim)) A.claims.push({ by: sp.id, role: rec.claim, day: room.day });
  for (const q of others) {
    if (rec.claim === 'police') {
      const isM = /마피아(였|입|이에요|야|다|로)/.test(text) && !/아니/.test(text);
      const isC = /(시민|깨끗|마피아가 아니|마피아 아니)/.test(text);
      if (isM || isC) A.res.push({ by: sp.id, target: q.id, res: isM ? 'mafia' : 'clean', day: room.day });
    }
    if (accuse && !vouch) A.acc.push({ by: sp.id, target: q.id, day: room.day, n: ++A.n, ev: rec.claim === 'police' || /조사|결과|증거|근거|봤|확인/.test(text) });
    else if (vouch && !accuse) A.vouch.push({ by: sp.id, target: q.id, day: room.day });
  }
  if (others.length === 1 && /투표|처형/.test(text) && !/하지 ?마|안 ?할/.test(text)) A.intent[sp.id] = { t: others[0].id, day: room.day };
  react(room);
}

// 말할 거리가 없으면 상황에 맞는 말을 하되, 같은 말을 되풀이하지 않는다
function contextLine(room, p) {
  const A = ai(room), b = pm(p);
  b.usedLines = b.usedLines || {};
  const alive = U.alive(room);
  const pool = [];
  const lastDead = Object.entries(A.dead).filter(([, d]) => d.day === room.day - (room.phase === 'day' ? 0 : 0) && d.phase === 'night').map(([id]) => U.byId(room, id)).filter(Boolean);
  if (lastDead.length && room.day >= 1) pool.push(`${lastDead[0].name}님이 밤에 당했네요. 마피아가 그분을 노린 이유가 뭘까요?`);
  const pc = claimants(room, 'police');
  if (pc.length >= 2) pool.push('경찰이 둘이라는 건 한 명이 거짓말이라는 뜻이에요. 누가 진짜인지 따져봐요.');
  if (pc.length === 1 && U.byId(room, pc[0]) && U.byId(room, pc[0]).alive && pc[0] !== p.id) pool.push('경찰이 나왔으니 그분 말을 잘 들어봐야겠어요.');
  pool.push(`지금 ${alive.length}명 남았어요. 한 번 실수하면 위험하니까 신중하게 가요.`);
  if (room.day === 1) pool.push(...FILLERS);
  else pool.push('말이 없는 사람이 누군지 살펴보고 있어요.', '단서가 부족해요. 확실한 근거가 있을 때 투표해요.');
  const fresh = pool.filter((t) => !b.usedLines[t]);
  if (!fresh.length) return null;
  const t = rnd(fresh); b.usedLines[t] = true;
  return t;
}
function botSpeak(room, p) {
  const L = lv(room, p), b = pm(p), A = ai(room);
  if (!canSpeak(room, p)) return;
  sync(room, p);
  if (p.role === 'police') { if (announcePolice(room, p)) return; }
  const fire = underFire(room, p);
  if (fire.hot) {
    if (p.role === 'police' && revealCleans(room, p)) return;
    if (!mafiaSide(p) && L.think >= 0.9 && claimRealRole(room, p)) return;
    if (mafiaSide(p) && L.fake && !claimedRole(room, p.id, 'police') && claimants(room, 'police').length === 0 && chance(0.7) && fakePolice(room, p)) return;
  }
  // 진짜 경찰은 가짜 경찰을 알아본다
  if (p.role === 'police' && L.think >= 0.7) {
    const liar = claimants(room, 'police').map((id) => U.byId(room, id)).find((x) => x && x.alive && x !== p && !b.announced['liar' + x.id]);
    if (liar) { b.announced['liar' + liar.id] = true; b.claimed.police = true; return void say(room, p, `제가 진짜 경찰이에요. ${liar.name}님은 경찰이 아니에요. 거짓말하고 있어요!`, { claim: 'police', acc: liar.id, res: { t: liar.id, r: 'mafia' } }); }
  }
  // 마피아 팀은 가끔 먼저 가짜 경찰을 내세워 판을 흔든다 (보통은 진짜 경찰이 나온 뒤 맞불)
  if (mafiaSide(p) && L.fake && room.day >= 3 && claimants(room, 'police').length === 0 && chance(0.12) && fakePolice(room, p)) return;
  // 지목
  const t = topSuspect(room, p);
  if (t && chance(0.8)) {
    const sc = sus(room, p, t);
    if (sc > (L.think >= 0.9 ? 12 : 8) - persona(p).sus) {
      const same = b.lastTop === t.id && b.lastTopDay === room.day;
      if (same) {
        if (b.intentSaid !== room.day && chance(L.intent)) { b.intentSaid = room.day; return void say(room, p, `이번엔 ${t.name}님에게 투표할 거예요.${reasonFor(room, p, t) || voteReasonFallback(room, p, t)}`, { intent: t.id }); }
      } else {
        b.lastTop = t.id; b.lastTopDay = room.day;
        return void say(room, p, accuseLine(room, p, t), { acc: t.id });
      }
    }
  }
  const line = contextLine(room, p);
  if (line) say(room, p, line);
}

// ------------------------------------------------------------ 투표
function tallyOf(room) {
  const t = {};
  for (const [vid, tid] of Object.entries(room.votes)) {
    if (tid === 'skip') continue;
    const v = U.byId(room, vid); if (!v) continue;
    t[tid] = (t[tid] || 0) + E.weight(v);
  }
  return t;
}
function botVoteAbility(room, p) {
  const vo = E.AB.voteOptions(room, p); if (!vo || !vo.targets.length) return;
  const cands = vo.targets.map((id) => U.byId(room, id)).filter(Boolean), b = pm(p);
  let t;
  if (p.role === 'forger') { // 위조범: 팀원을 "마피아 아님"으로, 아니면 경찰을 "마피아"로 위조
    const mates = cands.filter((c) => c === p || knownMate(p, c));
    const police = cands.filter((c) => !knownMate(p, c) && c !== p && claimedRole(room, c.id, 'police'));
    t = (police.length && chance(0.5)) ? rnd(police) : (mates.length ? rnd(mates) : rnd(cands));
  } else if (p.role === 'detective') { // 믿을 만한 사람과 비교
    const ref = best(cands, (c) => -sus(room, p, c) + (b.checks[c.id] === 'clean' ? 100 : 0), 2);
    t = ref;
  } else t = best(cands.filter((c) => !b.checks[c.id]), (c) => sus(room, p, c), lv(room, p).noise) || rnd(cands); // 밀고자: 의심스러운 사람
  if (t) act(room, p, { type: 'vact', target: t.id });
}
// 최후의 반론: 처형 후보가 된 봇이 한마디 한다
function botDefense(room, p) {
  const lines = mafiaSide(p)
    ? ['저는 마피아가 아니에요. 저를 처형하면 진짜 마피아만 좋아해요.', '억울해요! 제대로 따져 보고 결정해 주세요.']
    : ['저는 시민이에요. 저를 처형하면 마피아에게 이득이에요. 다시 생각해 주세요.', '억울합니다. 지금까지 한 말을 다시 떠올려 보세요.'];
  say(room, p, rnd(lines));
}
// 찬반투표: 내가 찍은 후보면 찬성, 아니면 의심 정도에 따라 (마피아는 팀원이면 반대)
function botConfirm(room, p) {
  const T = room.defense && U.byId(room, room.defense.id);
  if (!T || T === p) return;
  if (room.judgeOnly) { // 최후의 반론이 꺼진 판: 판사 봇만 가끔 판결
    if (p.role === 'judge' && U.usesLeft(room, p, 'judge') > 0 && !room.judgeVerdict && chance(0.4)) { sync(room, p); act(room, p, { type: 'judge', verdict: chance(Math.max(0.12, Math.min(0.9, 0.55 + sus(room, p, T) / 120))) ? 'yes' : 'no' }); }
    return;
  }
  if (!E.confirmVoters(room).includes(p)) return;
  sync(room, p);
  const L = lv(room, p);
  let yes;
  if (p.role === 'prosecutor') yes = chance(0.85); // 검사는 찬성, 변호사는 반대 쪽
  else if (p.role === 'lawyer') yes = chance(0.15);
  else if (mafiaSide(p) && knownMate(p, T)) yes = chance(L.mistake);
  else if (room.votes[p.id] === T.id) yes = chance(0.92);
  else { const W = L.wise || 0; const sc = W >= 0.7 ? 0.6 * sus(room, p, T, { noSocial: true }) + 0.4 * sus(room, p, T) : sus(room, p, T); yes = chance(Math.max(0.12, Math.min(0.93, 0.58 + sc / 120))); }
  if (p.role === 'judge' && U.usesLeft(room, p, 'judge') > 0 && !room.judgeVerdict && chance(0.55)) { act(room, p, { type: 'judge', verdict: yes ? 'yes' : 'no' }); return; } // 판사: 가끔 직접 판결
  act(room, p, { type: 'confirm', choice: yes ? 'yes' : 'no' });
}
function botVote(room, p) {
  const L = lv(room, p), A = ai(room);
  sync(room, p);
  botVoteAbility(room, p);
  if (!E.canVote(room, p)) return;
  if (room.settings.abstain && chance(L.skip)) return void act(room, p, { type: 'vote', target: 'skip' });
  const tally = tallyOf(room);
  const alive = U.alive(room);
  const mates = alive.filter((x) => knownMate(p, x));
  let cands = alive.filter((x) => x !== p && !immune(room, x));
  if (p.role === 'follower' && p.s.master) { const nm = cands.filter((x) => x.id !== p.s.master); if (nm.length) cands = nm; } // 신봉자는 주인을 처형하지 않는다
  if (!cands.length) return;
  const voters = alive.filter((x) => E.canVote(room, x)).length;
  const need = Math.floor(voters / 2) + 1;

  if (mafiaSide(p)) {
    if (!chance(L.mistake)) {
      if (L.sacrifice && mates.length) { // 팀원이 어차피 처형된다면 같이 찍어서 의심을 피한다
        const lead = mates.filter((c) => (tally[c.id] || 0) >= need - 1 && (tally[c.id] || 0) >= 2).sort((a, b) => (tally[b.id] || 0) - (tally[a.id] || 0))[0];
        if (lead && (tally[lead.id] || 0) >= need) return void act(room, p, { type: 'vote', target: lead.id });
      }
      const non = cands.filter((c) => !knownMate(p, c));
      if (non.length) cands = non;
    }
    if (L.coord) { // 팀의 계획: 팀원이 이미 찍은 대상이 있으면 같이 찍는다
      const pl = A.plan['v' + room.day];
      if (pl && cands.some((c) => c.id === pl)) return void act(room, p, { type: 'vote', target: pl });
    }
  }
  // 기권 판단: 단서가 너무 없으면 괜한 처형을 피한다 (마을 팀)
  const scored = cands.map((c) => ({ c, s: sus(room, p, c, { tally }) + Math.random() * L.noise * 0.4 })); // 투표는 판단에 무작위를 덜 섞는다
  scored.sort((a, b) => b.s - a.s);
  let top = scored[0];
  if (mafiaSide(p)) { // 마피아는 마을이 쏠리는 쪽 + 위협적인 사람
    let bs = -1e9;
    for (const x of scored) { const v = x.s * 0.6 + killValue(room, p, x.c) * 0.5 + (tally[x.c.id] || 0) * 6; if (v > bs) { bs = v; top = x; } }
    if (L.coord && !A.plan['v' + room.day]) A.plan['v' + room.day] = top.c.id;
  } else {
    // 마을은 표가 갈라지면 마피아가 원하는 사람이 처형된다: 단서가 약해도 가장 의심스러운 사람에게 표를 모은다
    // (결백하다는 근거가 있는 사람을 분위기만으로 따라 찍지는 않는다)
    if (L.consensus > 0 && chance(L.consensus)) {
      const lead = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
      if (lead && lead[1] >= 2) { const lc = scored.find((x) => x.c.id === lead[0]); if (lc && lc.s >= top.s - 40 * (1 - 0.6 * (L.wise || 0)) && (L.think < 0.5 || sus(room, p, lc.c, { noSocial: true }) > -25)) top = lc; }
    }
  }
  act(room, p, { type: 'vote', target: top.c.id });
}

// ------------------------------------------------------------ 단계 시작 시 호출
function schedule(room) {
  const seq = room.seq, phase = room.phase, L = lv(room);
  try { syncSys(room); } catch (e) { console.error('봇 오류', e); }
  if (phase === 'last') { // 처형된 테러리스트(봇)가 함께 죽을 사람을 고른다
    const T = U.byId(room, room.lastBoom);
    if (T && T.bot) {
      setTimeout(() => {
        if (room.seq !== seq || !deps.rooms.has(room.code) || room.lastBoom !== T.id) return;
        try {
          const cands = U.alive(room).filter((x) => x !== T && !knownMate(T, x));
          const c = best(cands.length ? cands : U.alive(room).filter((x) => x !== T), (x) => sus(room, T, x), L.noise);
          act(room, T, { type: 'boom', target: c ? c.id : null });
        } catch (e) { console.error('봇 오류', e); }
      }, 1500 + Math.random() * 4000);
    }
    return;
  }
  const sec = phase === 'night' ? room.settings.nightSec : phase === 'day' ? room.settings.daySec : phase === 'defense' || phase === 'speak' ? room.settings.defenseSec : phase === 'rps' ? (Number(process.env.NME_RPS_SEC) || 7) : phase === 'confirm' ? (Number(process.env.NME_CONFIRM_SEC) || 12) : room.settings.voteSec;
  for (const p of room.players) {
    if (!p.bot || !p.alive) continue;
    const L = lv(room, p);
    const at = (a, b, fn) => setTimeout(() => {
      if (room.seq !== seq || !deps.rooms.has(room.code) || !p.alive) return;
      try { fn(); } catch (e) { console.error('봇 오류', e); }
    }, 300 + (a + Math.random() * (b - a)) * sec * 1000);
    if (phase === 'night') at(0.1, 0.75, () => botNight(room, p));
    else if (phase === 'day') {
      syncPriv(room, p);
      if (p.role === 'police') at(0.02, 0.15, () => { sync(room, p); announcePolice(room, p); }); // 마피아를 찾았다면 아침 일찍 알린다
      const n = Math.max(1, Math.round(L.speak * persona(p).talk * (room.day === 1 ? 2.2 : 3.2) * (U.alive(room).length > 12 ? 0.7 : 1)));
      const slots = Array.from({ length: n }, () => 0.04 + Math.random() * 0.86).sort((a, b) => a - b);
      slots.forEach((f, i) => at(f, f, () => botSpeak(room, p)));
      if (chance(L.intent)) at(0.88, 0.97, () => { // 하루 끝에 투표 예고
        const t = topSuspect(room, p);
        if (t && sus(room, p, t) > 15 && pm(p).intentSaid !== room.day) { pm(p).intentSaid = room.day; say(room, p, `오늘은 ${t.name}님에게 투표할게요.`, { intent: t.id }); }
      });
    } else if (phase === 'vote') at(0.2, 0.85, () => botVote(room, p));
    else if (phase === 'defense') {
      if (room.defense && room.defense.id === p.id) at(0.1, 0.4, () => botDefense(room, p));
      else if ((p.role === 'prosecutor' || p.role === 'lawyer') && room.defense) at(0.15, 0.6, () => { // 검사·변호사: 능력을 쓸지 고른다
        sync(room, p); const T = U.byId(room, room.defense.id); if (!T) return;
        const s = sus(room, p, T);
        const use = p.role === 'prosecutor' ? chance(s > -20 ? 0.85 : 0.3) : chance(s < 40 ? 0.7 : 0.25);
        act(room, p, { type: 'extra', use });
      });
    }
    else if (phase === 'speak') { if (room.speaker === p.id) at(0.1, 0.4, () => say(room, p, p.role === 'prosecutor' ? rnd(['이 사람은 정말 수상해요. 처형에 찬성해 주세요.', '지금까지의 행동을 보면 마피아일 가능성이 높아요. 찬성해 주세요.']) : rnd(['성급한 처형은 위험해요. 반대에 투표해 주세요.', '확실한 증거가 없어요. 이번에는 반대해 주세요.']))); }
    else if (phase === 'rps') { if ((room.rps && room.rps.matches || []).some((m) => m.b === p.id || m.t === p.id)) at(0.1, 0.7, () => act(room, p, { type: 'rps', sign: rnd(['r', 'p', 's']) })); }
    else if (phase === 'confirm') at(0.15, 0.75, () => botConfirm(room, p));
  }
}

// 밤/투표 결과를 반영 (죽음 기록은 onDeath 에서)
function afterResolve(room, beforeIds, voteSnap) {
  const A = ai(room);
  if (!voteSnap) { // 밤: 마피아가 노렸는데 아무도 죽지 않았다면 그 대상은 공격이 안 통하는 사람일 수 있다
    const t = A.tried[room.day];
    const anyDied = beforeIds.some((id) => { const d = U.byId(room, id); return d && !d.alive; });
    if (t) A.fail[t] = anyDied ? 0 : (A.fail[t] || 0) + 1;
  } else {
    // 투표로 처형된 사람의 직업이 드러났다면, 그 처형을 민 사람과 처음 지목한 사람을 기록한다
    for (const id of beforeIds) {
      const d = U.byId(room, id), rec = A.dead[id];
      if (!d || d.alive || !rec || rec.how !== 'vote' || rec.day !== room.day || rec.scored) continue;
      rec.scored = true;
      const pr = A.pubRole[id]; if (!pr) continue;
      const team = ROLE[pr].team; if (team === 'neutral') continue;
      const bump = (vid, k) => { if (vid === id) return; const v = (A.vrec[vid] = A.vrec[vid] || { wrong: 0, right: 0 }); v[k] += 1; };
      const k = team === 'mafia' ? 'right' : 'wrong';
      for (const [vid, tid] of Object.entries(voteSnap)) if (tid === id) bump(vid, k);
      const first = A.acc.filter((a) => a.target === id && a.day === room.day).sort((x, y) => (x.n || 0) - (y.n || 0))[0];
      if (first && !first.ev) bump(first.by, k); // 처음 몰아간 사람은 더 큰 책임
    }
  }
}
// 누군가 죽을 때마다 호출
function onDeath(room, p, how) {
  const A = ai(room);
  const h = String(how || '');
  A.dead[p.id] = { day: room.day, phase: room.phase, how: h.includes('마피아에게') ? 'mafia' : h.includes('투표로') ? 'vote' : 'other' };
  if (room.settings.revealOnDeath) A.pubRole[p.id] = p.role;
}

module.exports = { init, schedule, hear, reset, afterResolve, onDeath, LEVEL_KEYS };
