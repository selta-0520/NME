'use strict';
// NME (Enemy Mafia · New Mafia Extended Mix) 서버 — 외부 패키지 없이 Node.js 기본 기능만 사용합니다.
// 실행: node server.js  →  http://localhost:3000
// 게임 규칙(직업 능력)은 engine/ 폴더에 있습니다.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROLES, ROLE, TEAM_NAMES, roleCap } = require('./roles');
const E = require('./engine');
const { U } = E;
const Bots = require('./bots');

const PORT = Number(process.env.PORT) || 3000;
const QUIET_LIMIT = 6;
const TIME_ADJ_MS = 10000; // 아침 시간 조절 한 번에 바뀌는 시간
const CONFIRM_SEC = Number(process.env.NME_CONFIRM_SEC) || 12; // 찬반투표 시간
const RPS_SEC = Number(process.env.NME_RPS_SEC) || 7; // 내기꾼 가위바위보 제한 시간
const WILL_MS = 10000; // 유언집행자 대화 시간
const LAST_SEC = 15; // 처형된 테러리스트가 함께 죽을 사람을 고르는 시간
// 어떤 오류가 나도 서버 전체가 꺼지지 않게 한다 (한 방의 오류가 모두의 접속을 끊지 않도록)
process.on('uncaughtException', (e) => console.error('[오류]', e && e.stack || e));
process.on('unhandledRejection', (e) => console.error('[오류]', e && e.stack || e));
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 50;
const LIMITS = {
  nightSec: [15, 180],
  daySec: [15, 600],
  voteSec: [10, 120],
  defenseSec: [5, 60],
  mafiaSize: [0, 25],
  neutralSize: [0, 25],
  citizenSize: [0, 50],
  mafiaSpecialMax: [0, 10],
  citizenSpecialMax: [0, 40],
  neutralMax: [0, 10],
  gamblerHits: [1, 10],
  destroyMax: [0, 10],
};
const USES_LIMIT = [1, 5]; // 횟수 제한 능력의 최소~최대 사용 횟수

const rooms = new Map();

// ---------------------------------------------------------------- 유틸
const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
const clamp = (v, [lo, hi], fallback) => {
  v = Math.round(Number(v));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
};
const byId = (room, id) => room.players.find((p) => p.id === id);
const alivePlayers = (room) => room.players.filter((p) => p.alive);
const roleName = (k) => ROLE[k].name;

// ---------------------------------------------------------------- 설정
function defaultSettings() {
  const roleMin = {}, roleMax = {};
  for (const r of ROLES) { roleMin[r.key] = 0; roleMax[r.key] = (r.key === 'mafia' || r.key === 'citizen') ? roleCap(r.key) : 1; }
  return {
    nightSec: 40,
    daySec: 90,
    voteSec: 30,
    finalDefense: true,
    defenseSec: 15,
    mafiaSize: 0,
    neutralSize: 0,
    citizenSize: 0,
    mafiaSpecialMax: 2,
    citizenSpecialMax: 12,
    neutralMax: 2,
    gamblerHits: 3,
    destroyMax: 0, // 파괴자 파괴 횟수 (0 = 자동: 시작 인원 ÷ 3)
    uses: Object.fromEntries(U.USE_KEYS.map((k) => [k, 1])), // 횟수 제한 능력의 사용 횟수
    abstain: false, // 투표 기권 허용
    teamKill: false, // 마피아 팀킬 허용 (마피아 팀이 같은 팀을 공격할 수 있음)
    revealOnDeath: false,
    jokerReveal: 'off', // off | shuffle | end
    randomEvents: false, // 낮마다 가끔 랜덤 이벤트
    publicRoom: false, // 공개방 목록에 보이기
    jokerMode: 'shuffle', // shuffle(있던 직업끼리 섞기) | reroll(전체 직업에서 새로 뽑기)
    botLevel: 'normal',
    selfVote: true,
    forcedRoles: [],
    enabledRoles: ROLES.map((r) => r.key),
    roleMin, roleMax,
  };
}
function applySettings(s, patch) {
  for (const k of Object.keys(LIMITS)) {
    if (patch[k] !== undefined) s[k] = clamp(patch[k], LIMITS[k], s[k]);
  }
  if (patch.revealOnDeath !== undefined) s.revealOnDeath = !!patch.revealOnDeath;
  if (patch.finalDefense !== undefined) s.finalDefense = !!patch.finalDefense;
  if (patch.randomEvents !== undefined) s.randomEvents = !!patch.randomEvents;
  if (patch.publicRoom !== undefined) s.publicRoom = !!patch.publicRoom;
  if (patch.jokerMode !== undefined && ['shuffle', 'reroll'].includes(patch.jokerMode)) s.jokerMode = patch.jokerMode;
  if (patch.jokerReveal !== undefined && ['off', 'shuffle', 'end'].includes(patch.jokerReveal)) s.jokerReveal = patch.jokerReveal;
  if (Bots.LEVEL_KEYS.includes(patch.botLevel)) s.botLevel = patch.botLevel;
  if (patch.selfVote !== undefined) s.selfVote = !!patch.selfVote;
  if (patch.abstain !== undefined) s.abstain = !!patch.abstain;
  if (patch.teamKill !== undefined) s.teamKill = !!patch.teamKill;
  if (patch.uses && typeof patch.uses === 'object') {
    s.uses = s.uses || {};
    for (const k of U.USE_KEYS) if (patch.uses[k] !== undefined) s.uses[k] = clamp(patch.uses[k], USES_LIMIT, s.uses[k] || 1);
  }
  const ok = new Set(ROLES.map((r) => r.key));
  const clean = (l) => [...new Set(l)].filter((k) => ok.has(k));
  const prevEn = s.enabledRoles.slice(), prevFo = s.forcedRoles.slice();
  const enable = (k) => { if (!s.enabledRoles.includes(k)) s.enabledRoles.push(k); };
  // 거지·부자는 한 묶음이라 값을 항상 같이 바꾼다
  const mates = (k) => { const pr = PAIRS.find((x) => x.includes(k)); return pr ? pr.slice() : [k]; };
  if (Array.isArray(patch.enabledRoles)) {
    s.enabledRoles = fixPair(clean(patch.enabledRoles), prevEn);
    for (const k of prevEn) if (!s.enabledRoles.includes(k)) s.roleMin[k] = 0; // 끄면 필수도 해제
  }
  if (Array.isArray(patch.forcedRoles)) { // ⭐ 필수 = 최소 1명
    const fo = fixPair(clean(patch.forcedRoles), prevFo);
    for (const k of fo) if (!prevFo.includes(k)) { s.roleMin[k] = Math.max(1, s.roleMin[k] | 0); if (s.roleMax[k] < s.roleMin[k]) s.roleMax[k] = s.roleMin[k]; enable(k); }
    for (const k of prevFo) if (!fo.includes(k)) s.roleMin[k] = 0;
  }
  const num = (k, v) => clamp(v, [0, roleCap(k)], null);
  if (patch.roleMin && typeof patch.roleMin === 'object') {
    for (const [k0, v] of Object.entries(patch.roleMin)) {
      if (!ok.has(k0) || SECOND.has(k0)) continue;
      const n = num(k0, v); if (n === null) continue;
      for (const k of mates(k0)) { s.roleMin[k] = n; if (s.roleMax[k] < n) s.roleMax[k] = n; if (n > 0) enable(k); }
    }
  }
  if (patch.roleMax && typeof patch.roleMax === 'object') {
    for (const [k0, v] of Object.entries(patch.roleMax)) {
      if (!ok.has(k0) || SECOND.has(k0)) continue;
      const n = num(k0, v); if (n === null) continue;
      for (const k of mates(k0)) { s.roleMax[k] = n; if (s.roleMin[k] > n) s.roleMin[k] = n; }
    }
  }
  // 필수 목록은 "최소 1명 이상"인 직업으로 항상 맞춰 둔다
  s.forcedRoles = ROLES.map((r) => r.key).filter((k) => s.enabledRoles.includes(k) && s.roleMin[k] >= 1);
}
// 한 묶음으로 배정되는 직업 쌍: 거지 & 부자, 검사 & 변호사. 한쪽만 바뀌어 오면 이전 상태를 보고 둘 다 켜거나 둘 다 끈다
const PAIRS = [['beggar', 'rich']];
const SECOND = new Set(PAIRS.map((x) => x[1]));
function fixPair(list, prev) {
  for (const [a, b] of PAIRS) {
    const ha = list.includes(a), hb = list.includes(b);
    if (ha === hb) continue;
    const base = list.filter((k) => k !== a && k !== b);
    const prevBoth = prev.includes(a) && prev.includes(b);
    list = prevBoth ? base : [...base, a, b];
  }
  return list;
}

// ---------------------------------------------------------------- 방
function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += chars[crypto.randomInt(chars.length)];
    if (!rooms.has(c)) return c;
  }
}
function makePlayer(name) {
  return { id: rid(4), token: rid(16), name, role: null, alive: true, conns: new Set(),
    lastChat: 0, dcTimer: null, bot: false, s: {}, team: null, contacted: false, destroyed: false, exorcised: false };
}
function createRoom(hostName) {
  const host = makePlayer(hostName);
  const room = {
    code: newCode(), hostId: host.id, players: [host], settings: defaultSettings(),
    phase: 'lobby', day: 0, seq: 0, timer: null, endsAt: 0,
    night: null, votes: {}, voteActs: {}, touches: [], pendingWin: null,
    chat: [], msgId: 0, winner: null, lastActive: Date.now(), specs: [],
  };
  rooms.set(room.code, room);
  return { room, player: host };
}

// ---------------------------------------------------------------- 전송
function sse(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { /* 끊긴 연결 */ }
}
function sendToPlayer(p, event, data) { for (const res of p.conns) sse(res, event, data); }
// 👀 관전자: room.players(게임 참가자)와 따로 room.specs 에 둔다. 게임 규칙 코드는 관전자를 전혀 모른다.
const members = (room) => room.players.concat(room.specs || []);
const canSee = (room, p, m) => (p.spec ? ['all', 'sys', 'spec'].includes(m.ch) : E.canSeeMsg(room, p, m));
const MAX_SPECS = 30;
const pubMsg = (m) => ({ id: m.id, ch: m.ch, name: m.anon ? '익명' + m.anon : m.name, text: m.text, t: m.t });

function addChat(room, ch, text, from, to) {
  const m = { id: ++room.msgId, ch, name: from ? from.name : '', from: from ? from.id : null, to: to || null,
    text, t: Date.now(), night: room.phase === 'night' };
  if (from && ch === 'all' && room.anonDay === room.day && ['day', 'vote', 'defense', 'speak', 'confirm'].includes(room.phase) && from.anonN) m.anon = from.anonN; // 익명의 날
  room.chat.push(m);
  if (room.chat.length > 400) room.chat.shift();
  for (const p of members(room)) if (canSee(room, p, m)) sendToPlayer(p, 'chat', pubMsg(m));
  if (from && !from.bot && !m.anon && ch === 'all' && (room.phase === 'day' || room.phase === 'vote' || room.phase === 'defense' || room.phase === 'speak' || room.phase === 'confirm')) Bots.hear(room, { from: from.id, text });
  return m;
}
function sendBacklog(room, p) {
  const list = room.chat.filter((m) => canSee(room, p, m)).slice(-200).map(pubMsg);
  sendToPlayer(p, 'backlog', list);
}

function killPlayer(room, p, how) {
  p.alive = false;
  const rev = room.settings.revealOnDeath ? ` (직업: ${roleName(p.role)})` : '';
  addChat(room, 'sys', `💀 ${p.name}님이 ${how}${rev}`);
  Bots.onDeath(room, p, how);
  // 거지와 부자는 운명공동체: 한쪽이 죽으면 다른 쪽도 함께 죽는다
  if (p.role === 'beggar' || p.role === 'rich') {
    const mateRole = p.role === 'beggar' ? 'rich' : 'beggar';
    const mate = room.players.find((x) => x.alive && x !== p && x.role === mateRole);
    if (mate) killPlayer(room, mate, `짝인 ${roleName(p.role)} ${p.name}님이 죽어서 함께 사망했습니다. (거지와 부자는 운명공동체)`);
  }
}
// 엔진이 쓰는 출력 함수 연결
U.io.sys = (room, text) => addChat(room, 'sys', text);
U.io.priv = (room, p, text) => addChat(room, 'priv', text, null, p.id);
U.io.kill = killPlayer;

function specView(room, sp) {
  const s = room.settings, inGame = room.phase !== 'lobby';
  const players = room.players.map((q) => {
    const o = { id: q.id, name: q.name, alive: q.alive, host: q.id === room.hostId, connected: q.bot || q.conns.size > 0, bot: !!q.bot };
    if (inGame && q.role && (room.phase === 'ended' || (!q.alive && s.revealOnDeath))) o.role = q.role; // 관전자도 공개된 직업만 본다
    return o;
  });
  const v = {
    code: room.code, phase: room.phase, day: room.day, endsAt: room.endsAt, now: Date.now(), spectator: true,
    hostId: room.hostId, meId: sp.id, players, specs: room.specs.map((x) => ({ id: x.id, name: x.name, connected: x.conns.size > 0, me: x.id === sp.id })),
    settings: s, winner: room.winner, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
  };
  if (room.phase === 'ended') { v.replay = room.replay || []; v.titles = room.titles || []; }
  if ((room.phase === 'defense' || room.phase === 'speak' || room.phase === 'confirm') && room.defense) { const T = byId(room, room.defense.id); v.defense = { id: room.defense.id, name: T ? T.name : '' }; }
  if (room.phase === 'vote') {
    const tally = {}; let skip = 0;
    for (const [vid, tg] of Object.entries(room.votes)) { const voter = byId(room, vid); if (!voter) continue; if (tg === 'skip') skip++; else tally[tg] = (tally[tg] || 0) + E.weight(voter); }
    v.tally = tally; v.skip = skip; v.voted = Object.keys(room.votes).length;
    v.eligible = alivePlayers(room).filter((x) => E.canVote(room, x)).length;
  }
  return v;
}

function viewFor(room, p) {
  if (p.spec) return specView(room, p);
  const s = room.settings;
  const inGame = room.phase !== 'lobby';
  const players = room.players.map((q) => {
    const o = { id: q.id, name: q.name, alive: q.alive, host: q.id === room.hostId, connected: q.bot || q.conns.size > 0, bot: !!q.bot };
    if (inGame && q.role && E.knowsRole(room, p, q)) {
      o.role = (room.phase === 'ended' || (!q.alive && s.revealOnDeath)) ? q.role : E.shownRoleTo(p, q);
    }
    return o;
  });
  const v = {
    code: room.code, phase: room.phase, day: room.day, endsAt: room.endsAt, now: Date.now(),
    hostId: room.hostId, meId: p.id, players, settings: s, winner: room.winner,
    minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
    specs: (room.specs || []).map((x) => ({ id: x.id, name: x.name, connected: x.conns.size > 0 })),
  };
  if (room.phase === 'ended') { v.replay = room.replay || []; v.titles = room.titles || []; }
  if (inGame) {
    v.me = E.meView(room, p);
    if (room.phase === 'day' || room.phase === 'vote') v.immune = room.players.filter((x) => U.voteImmune(room, x)).map((x) => x.id);
    if (room.phase === 'day') v.dayAdj = (room.dayAdj && room.dayAdj[p.id]) || null;
    if (room.phase === 'speak' && room.speaker === p.id) v.speaker = { id: p.id, name: p.name }; // 다른 사람에게는 누가 발언하는지 알리지 않는다
    if (room.phase === 'rps') v.rpsCount = (room.rps && room.rps.matches.length) || 0;
    if (room.phase === 'day' && E.AB.activeWill(room, p)) { const w = E.AB.activeWill(room, p); const o = byId(room, w.a === p.id ? w.b : w.a); v.will = { until: w.until, with: o ? o.name : '' }; }
    if (room.phase === 'last' && room.lastBoom) { const t = byId(room, room.lastBoom); v.last = { terrorist: room.lastBoom, name: t ? t.name : '' }; }
    if (p.alive && p.role === 'beggar' && p.s.met && room.begAt && (room.phase === 'day' || room.phase === 'vote' || room.phase === 'defense' || room.phase === 'speak' || room.phase === 'confirm')) v.begAt = room.begAt;
    if ((room.phase === 'defense' || room.phase === 'speak' || room.phase === 'confirm') && room.defense) {
      const T = byId(room, room.defense.id);
      v.defense = { id: room.defense.id, name: T ? T.name : '' };
      v.judgeOnly = !!room.judgeOnly;
      if (room.phase === 'confirm') {
        const c = Object.entries(room.confirm || {}).filter(([pid]) => { const x = byId(room, pid); return x && x.alive; });
        const voters = E.confirmVoters(room);
        v.confirm = {
          yes: c.filter(([, k]) => k === 'yes').length, no: c.filter(([, k]) => k === 'no').length,
          voted: c.length, eligible: voters.length, mine: (room.confirm || {})[p.id] || null,
          canVote: p.alive && voters.some((x) => x.id === p.id),
        };
      }
    }
    if (room.phase === 'vote') {
      const tally = {}; let skip = 0;
      for (const [vid, t] of Object.entries(room.votes)) {
        const voter = byId(room, vid);
        if (!voter) continue;
        if (t === 'skip') skip++; else tally[t] = (tally[t] || 0) + E.weight(voter);
      }
      v.tally = tally; v.skip = skip;
      v.voted = Object.keys(room.votes).length;
      v.eligible = alivePlayers(room).filter((x) => E.canVote(room, x)).length;
    }
  }
  return v;
}
// ---------------------------------------------------------------- 거지: 부자를 만난 뒤 12~17초마다 채팅해야 함
const BEG_MIN = 12000, BEG_MAX = 17000;
function clearBeg(room) { clearTimeout(room.begTimer); room.begTimer = null; room.begAt = 0; }
function activeBeggar(room) { // 지금 채팅할 수 있는 만난 거지
  if (room.phase !== 'day' && room.phase !== 'vote' && room.phase !== 'defense' && room.phase !== 'speak' && room.phase !== 'confirm') return null;
  const b = room.players.find((x) => x.alive && x.role === 'beggar' && x.s.met);
  return b && E.chatInfo(room, b).ch === 'all' ? b : null;
}
function scheduleBeg(room) {
  clearBeg(room);
  const b = activeBeggar(room);
  if (!b) return;
  const ms = BEG_MIN + Math.floor(Math.random() * (BEG_MAX - BEG_MIN + 1));
  room.begAt = Date.now() + ms;
  const seq = room.seq;
  room.begTimer = setTimeout(() => {
    if (room.seq !== seq || !rooms.has(room.code)) return;
    const bb = activeBeggar(room);
    if (!bb) { room.begAt = 0; return; }
    addChat(room, 'all', '한푼 줍쇼', bb); // 거지가 말이 없으면 대신 자동으로 말한다
    scheduleBeg(room);
  }, ms);
  sendToPlayer(b, 'state', viewFor(room, b)); // 거지에게 새 카운트다운을 알림
}

function broadcastState(room) {
  for (const p of members(room)) if (p.conns.size) sendToPlayer(p, 'state', viewFor(room, p));
}

// ---------------------------------------------------------------- 게임 진행
// ---- 📼 리플레이 기록: 밤마다 누가 누구를 골랐는지, 투표는 누가 누구에게 했는지, 그 결과 공지
const SKIP_LINE = /^(☀️|🌙|🗳 투표 시간|⚖️ 찬반투표:|🛡 최후의 반론:)/;
function logStep(room, entry, markFrom) {
  const lines = room.chat.filter((m) => m.id > markFrom && m.ch === 'sys' && !SKIP_LINE.test(m.text)).map((m) => m.text);
  room.replay = room.replay || [];
  room.replay.push(Object.assign({ day: room.day, lines }, entry));
  room.replayMark = room.msgId;
}
// 🏅 끝난 뒤 칭호
function makeTitles(room) {
  const out = [], rp = room.replay || [];
  const team = (id) => { const q = byId(room, id); return q && q.role ? ROLE[q.role].team : null; };
  const hit = { good: {}, bad: {} }, victims = [];
  for (const e of rp) {
    if (e.kind !== 'vote') continue;
    for (const d of e.died || []) {
      const tm = team(d); if (!tm || tm === 'neutral') continue;
      if (tm === 'citizen') victims.push(d);
      for (const [vid, tid] of e.votes || []) if (tid === d) { const o = tm === 'mafia' ? hit.good : hit.bad; o[vid] = (o[vid] || 0) + 1; }
    }
  }
  const top = (o) => { const e = Object.entries(o).sort((a, b) => b[1] - a[1]); if (!e.length) return null; const m = e[0][1]; return { ids: e.filter((x) => x[1] === m).map((x) => x[0]), n: m }; };
  const g = top(hit.good); if (g) out.push({ icon: '🕵', title: '명탐정', desc: `마피아 팀 처형에 가장 많이 투표 (${g.n}번)`, ids: g.ids });
  const b = top(hit.bad); if (b) out.push({ icon: '🤦', title: '오판왕', desc: `무고한 시민 처형에 가장 많이 투표 (${b.n}번)`, ids: b.ids });
  if (victims.length) out.push({ icon: '🥲', title: '억울한 희생양', desc: '투표로 처형된 시민 팀', ids: victims.slice(0, 4) });
  const chats = room.players.filter((x) => (x.chats || 0) > 0).sort((x, y) => y.chats - x.chats);
  if (chats.length && chats[0].chats >= 3) out.push({ icon: '💬', title: '수다왕', desc: `전체 대화 ${chats[0].chats}번`, ids: chats.filter((x) => x.chats === chats[0].chats).map((x) => x.id) });
  const real = room.players.filter((x) => !x.bot);
  const quiet = real.slice().sort((x, y) => (x.chats || 0) - (y.chats || 0))[0];
  if (quiet && real.length > 1 && (quiet.chats || 0) <= 1 && chats.length && chats[0].chats >= 5) out.push({ icon: '🤐', title: '과묵한 사람', desc: '거의 말하지 않았어요', ids: [quiet.id] });
  const alive = alivePlayers(room);
  if (alive.length === 1) out.push({ icon: '🏃', title: '마지막 생존자', desc: '끝까지 살아남았어요', ids: [alive[0].id] });
  return out;
}

// 🎲 랜덤 이벤트 (설정에서 켠 경우, 2일차부터 낮마다 30%)
function rollEvent(room) {
  room.eventToday = null; room.anonDay = 0;
  if (!room.settings.randomEvents || room.day < 2 || Math.random() > 0.3) return;
  const alive = alivePlayers(room);
  const kinds = ['hint', 'short', 'anon'];
  const k = kinds[crypto.randomInt(kinds.length)];
  room.eventToday = k;
  if (k === 'hint') {
    const n = alive.filter((x) => ROLE[x.role].team === 'mafia').length;
    addChat(room, 'sys', `🎲 오늘의 이벤트 — 💡 힌트의 날: 지금 살아 있는 마피아 팀은 ${n}명이에요.`);
  } else if (k === 'short') {
    addChat(room, 'sys', '🎲 오늘의 이벤트 — ⏳ 짧은 토론의 날: 오늘 토론 시간이 절반이에요!');
  } else {
    alive.forEach((x, i) => { x.anonN = 0; });
    const order = shuffleArr(alive.slice()); order.forEach((x, i) => { x.anonN = i + 1; });
    room.anonDay = room.day;
    addChat(room, 'sys', '🎲 오늘의 이벤트 — 🎭 익명의 날: 오늘 대화에서는 이름이 가려져요. 말투와 내용으로 추리하세요!');
  }
}
const shuffleArr = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// 📜 유언집행자: 밤에 죽은 사람과 낮이 시작되고 잠깐 단둘이 대화한다
function openWills(room) {
  const list = room.wills || []; room.wills = []; room.willChats = [];
  for (const w of list) {
    const a = byId(room, w.a), b = byId(room, w.b);
    if (!a || !b || !a.alive || b.alive) continue;
    room.willChats.push({ a: a.id, b: b.id, until: Date.now() + WILL_MS });
    U.priv(room, a, `📜 지금부터 ${WILL_MS / 1000}초 동안 ${b.name}님과 단둘이 대화할 수 있어요. (채팅창에 쓴 말은 ${b.name}님에게만 전달돼요)`);
    U.priv(room, b, `📜 유언집행자 ${a.name}님이 ${WILL_MS / 1000}초 동안 당신과 대화하고 싶어 해요. (채팅창에 쓴 말은 ${a.name}님에게만 전달돼요)`);
  }
  if (room.willChats.length) setTimeout(() => { if (rooms.has(room.code)) broadcastState(room); }, WILL_MS + 200);
}

function setPhase(room, phase) {
  clearTimeout(room.timer);
  room.phase = phase;
  room.seq++;
  const s = room.settings;
  if (phase === 'day') { rollEvent(room); openWills(room); }
  let sec = phase === 'night' ? s.nightSec : phase === 'day' ? s.daySec : phase === 'vote' ? s.voteSec : phase === 'defense' || phase === 'speak' ? s.defenseSec : phase === 'rps' ? RPS_SEC : phase === 'confirm' ? CONFIRM_SEC : phase === 'last' ? LAST_SEC : 0;
  if (phase === 'day' && room.eventToday === 'short') sec = Math.max(15, Math.round(sec / 2)); // ⏳ 짧은 토론의 날
  if (sec) {
    room.endsAt = Date.now() + sec * 1000;
    const seq = room.seq;
    room.timer = setTimeout(() => { if (room.seq === seq) safeAdvance(room); }, sec * 1000);
  } else room.endsAt = 0;
  if (phase === 'night') E.startNight(room);
  if (phase === 'day') room.dayAdj = {};
  if (phase === 'night') room.cycleAlive = alivePlayers(room).length;
  if (phase === 'vote') { room.votes = {}; room.voteActs = {}; room.defense = null; room.confirm = {}; room.judgeVerdict = null; room.judgeOnly = false; }
  if (phase === 'confirm') { room.confirm = {}; room.judgeVerdict = null; }
  broadcastState(room);
  if (phase === 'day' || phase === 'vote' || phase === 'defense' || phase === 'speak' || phase === 'confirm') scheduleBeg(room); else clearBeg(room);
  if (phase === 'night' || phase === 'day' || phase === 'vote' || phase === 'defense' || phase === 'speak' || phase === 'rps' || phase === 'confirm' || phase === 'last') Bots.schedule(room);
}

function startGame(room) {
  Bots.reset(room);
  clearBeg(room); room.lastBoom = null; room.lastPick = null;
  room.jokerBefore = null; room.reports = {}; room.replay = []; room.titles = []; room.eventToday = null; room.anonDay = 0;
  room.wills = []; room.willChats = []; room.rps = null; room.judgeVerdict = null; room.judgeOnly = false; room.speaker = null; room.speakQueue = [];
  for (const x of room.players) x.chats = 0;
  const skipped = E.assignRoles(room);
  room.quiet = 0;
  room.day = 1; room.winner = null; room.replayMark = room.msgId; room.votes = {}; room.voteActs = {};
  addChat(room, 'sys', '🎭 게임이 시작되었습니다! 직업이 배정되었어요.');
  if (skipped && skipped.length) addChat(room, 'sys', `⚠ 인원이 부족해 필수 직업 중 ${skipped.map(roleName).join(', ')}은(는) 이번 판에 넣지 못했어요.`);
  for (const t of room.assignNotes || []) addChat(room, 'sys', t);
  for (const p of room.players) {
    U.priv(room, p, `🎭 당신의 직업은 "${roleName(p.role)}" (${TEAM_NAMES[ROLE[p.role].team]}) 입니다.`);
    if (U.inMafiaChat(p)) {
      const mates = room.players.filter((x) => x !== p && U.inMafiaChat(x));
      U.priv(room, p, `🔪 마피아 팀: ${U.names(mates) || '(없음)'}`);
    }
    if (p.role === 'follower') U.masterNote(room, p);
    if (p.role === 'couple') {
      const m = room.players.find((x) => x !== p && x.role === 'couple');
      if (m) U.priv(room, p, `💕 당신의 커플은 ${m.name}님입니다.`);
    }
  }
  addChat(room, 'sys', '🌙 1일차 밤이 되었습니다.');
  setPhase(room, 'night');
  for (const p of members(room)) sendBacklog(room, p);
}

function endGame(room, w) {
  w = E.prophetCheck(room, w); // 예언가: 절반 이상 맞혔다면 모든 승리를 취소하고 우승
  room.winner = w;
  try { room.titles = makeTitles(room); } catch (e) { room.titles = []; console.error('칭호 오류', e); }
  addChat(room, 'sys', w.text);
  const list = room.players.map((p) => `${p.name}(${roleName(p.role)}${p.alive ? '' : '·사망'})`).join(', ');
  addChat(room, 'sys', `📋 직업 공개: ${list}`);
  if (room.settings.jokerReveal === 'end' && room.jokerBefore) addChat(room, 'sys', `📜 광대가 섞기 전의 원래 직업: ${room.jokerBefore}`);
  setPhase(room, 'ended');
  for (const p of members(room)) sendBacklog(room, p);
}

// 단계 넘기기에서 오류가 나면 기록만 하고, 게임이 멈추지 않도록 다음 단계로 강제 이동을 시도한다
function safeAdvance(room) {
  try { advance(room); } catch (e) {
    console.error('[단계 진행 오류]', e && e.stack || e);
    room.lastBoom = null;
    if (room.phase === 'defense' || room.phase === 'speak' || room.phase === 'confirm') { room.defense = null; room.day++; room.phase = 'vote'; } // 찬반투표 중 오류: 다음 밤으로 안전하게 넘김
    try { if (room.phase !== 'lobby' && room.phase !== 'ended') { room.day = room.day || 1; setPhase(room, room.phase === 'night' || room.phase === 'rps' ? 'day' : room.phase === 'day' ? 'vote' : 'night'); } } catch (e2) { console.error('[복구 실패]', e2 && e2.stack || e2); }
  }
}
// 🌙 밤 결과 처리 후 낮으로
function resolveNightStep(room) {
  const before = alivePlayers(room).map((x) => x.id);
  const acts = Object.entries((room.night && room.night.acts) || {}).map(([id, a]) => ({ by: id, role: (byId(room, id) || {}).role, to: a.target, mode: a.mode || null }));
  const mark = room.replayMark || 0;
  E.resolveNight(room);
  logStep(room, { kind: 'night', acts, died: before.filter((id) => { const x = byId(room, id); return x && !x.alive; }) }, mark);
  Bots.afterResolve(room, before, null);
  const w = E.checkWin(room);
  if (w) endGame(room, w); else setPhase(room, 'day');
}
// ✊ 내기꾼 가위바위보 대결 시작
function startRps(room, matches) {
  room.rps = { matches };
  for (const m of matches) {
    const b = byId(room, m.b), t = byId(room, m.t);
    if (!b || !t) continue;
    U.priv(room, b, `✊ ${t.name}님과 가위바위보! ${RPS_SEC}초 안에 내세요. 내지 않으면 져요.`);
    U.priv(room, t, `✊ 내기꾼 ${b.name}님이 가위바위보를 걸어왔어요! ${RPS_SEC}초 안에 내지 않으면 져요.`);
  }
  setPhase(room, 'rps');
}
// ⚔️ 검사 → 변호사 순서로 추가 발언, 끝나면 찬반투표
function nextSpeakOrConfirm(room) {
  const id = (room.speakQueue || []).shift();
  if (id) {
    const sp = byId(room, id);
    if (!sp || !sp.alive) return nextSpeakOrConfirm(room);
    room.speaker = sp.id;
    addChat(room, 'sys', `⚔️ 추가 발언 시간입니다. (${room.settings.defenseSec}초) 추가 발언을 하는 사람만 말할 수 있어요.`);
    U.priv(room, sp, `⚔️ 당신의 추가 발언 시간이에요! ${room.settings.defenseSec}초 동안 채팅으로 설득하세요. (말하지 않아도 돼요. 정체는 공개되지 않아요)`);
    setPhase(room, 'speak');
    return;
  }
  room.speaker = null;
  addChat(room, 'sys', `⚖️ 찬반투표: ${room.defense && byId(room, room.defense.id) ? byId(room, room.defense.id).name : ''}님의 처형에 찬성하나요, 반대하나요? (동점이면 처형 무효)`);
  setPhase(room, 'confirm');
}
function advance(room) {
  if (room.phase === 'night') {
    const ms = E.rpsMatches(room);
    if (ms.length) { startRps(room, ms); return; }
    resolveNightStep(room);
  } else if (room.phase === 'rps') {
    if (room.rps) E.rpsResolve(room);
    room.phase = 'night'; // 밤 능력 처리는 밤 단계에서만 되므로 잠시 되돌린다 (바로 낮으로 넘어간다)
    resolveNightStep(room);
  } else if (room.phase === 'day') {
    addChat(room, 'sys', '🗳 투표 시간입니다. 처형할 사람을 선택하세요.');
    setPhase(room, 'vote');
  } else if (room.phase === 'vote') {
    const t = E.tallyVote(room);
    if (room.settings.finalDefense && t.leader && t.leader.alive && room.players.filter((x) => x.alive && x !== t.leader).length) {
      // 최후의 반론 → 찬반투표
      E.announceTally(room, t);
      room.defense = { id: t.leader.id }; room.extra = {};
      addChat(room, 'sys', `🛡 최후의 반론: ${t.leader.name}님이 처형 후보입니다. ${room.settings.defenseSec}초 동안 ${t.leader.name}님만 말할 수 있어요.`);
      setPhase(room, 'defense');
      return;
    }
    if (!room.settings.finalDefense && t.leader && t.leader.alive && alivePlayers(room).some((x) => U.dayRole(x) === 'judge' && x !== t.leader && U.usesLeft(room, x, 'judge') > 0)) {
      // 최후의 반론이 꺼져 있어도 판사는 판결할 수 있다: 처형 직전에 짧은 시간을 준다 (판결이 없으면 그대로 처형)
      E.announceTally(room, t);
      room.defense = { id: t.leader.id }; room.judgeOnly = true;
      addChat(room, 'sys', `⚖️ ${t.leader.name}님이 처형 후보입니다. 판사에게 판결할 기회가 주어집니다. (판결이 없으면 그대로 처형)`);
      setPhase(room, 'confirm');
      return;
    }
    finishVote(room, null);
  } else if (room.phase === 'defense') {
    if (!E.confirmVoters(room).length) { finishVote(room, { ok: true }); return; } // 투표할 사람이 없으면 그대로 진행
    const T = room.defense && byId(room, room.defense.id);
    // 검사·변호사가 능력을 쓰겠다고 고른 경우에만 추가 발언 (아무도 안 썼으면 바로 찬반투표)
    room.speakQueue = ['prosecutor', 'lawyer'].flatMap((r) => alivePlayers(room).filter((x) => U.dayRole(x) === r && x !== T && room.extra && room.extra[x.id])).map((x) => x.id);
    nextSpeakOrConfirm(room);
  } else if (room.phase === 'speak') {
    room.speaker = null;
    nextSpeakOrConfirm(room);
  } else if (room.phase === 'confirm') {
    const c = E.confirmTally(room);
    if (room.judgeOnly) { // 판사만 판결할 수 있었던 경우: 판결이 없으면 처형
      room.judgeOnly = false;
      const ok = c.judged ? c.ok : true;
      const j = c.judged && byId(room, c.judge);
      addChat(room, 'sys', c.judged ? `⚖️ 판사 ${j ? j.name : ''}님의 판결로 처형이 ${ok ? '확정' : '무효'}되었습니다.` : '⚖️ 판사의 판결이 없어 투표 결과대로 처형합니다.');
      finishVote(room, { ok });
      return;
    }
    if (c.judged) { const j = byId(room, c.judge); addChat(room, 'sys', `⚖️ 판사 ${j ? j.name : ''}님의 판결로 처형이 ${c.ok ? '확정' : '무효'}되었습니다. (표 계산: 찬성 ${c.yes} · 반대 ${c.no})`); }
    else addChat(room, 'sys', `⚖️ 찬반투표 결과: 찬성 ${c.yes} · 반대 ${c.no}`);
    finishVote(room, { ok: c.ok });
  } else if (room.phase === 'last') {
    const before = alivePlayers(room).map((x) => x.id);
    E.resolveBoom(room, room.lastPick || null);
    Bots.afterResolve(room, before, {});
    afterVote(room);
  }
}

// 투표 결과를 실제로 처리 (defense 가 있으면 최후의 반론·찬반투표를 거친 결과)
function finishVote(room, defense) {
  const before = alivePlayers(room).map((x) => x.id), snap = Object.assign({}, room.votes);
  const mark = room.replayMark || 0;
  E.resolveVote(room, defense ? { defense } : null);
  logStep(room, { kind: 'vote', votes: Object.entries(snap), died: before.filter((id) => { const x = byId(room, id); return x && !x.alive; }) }, mark);
  room.defense = null; room.judgeOnly = false;
  Bots.afterResolve(room, before, snap);
  if (room.lastBoom && alivePlayers(room).length) { // 처형된 테러리스트가 함께 죽을 사람을 고르는 시간
    addChat(room, 'sys', '💣 처형된 테러리스트가 함께 죽을 사람을 고르고 있습니다…');
    setPhase(room, 'last');
    return;
  }
  room.lastBoom = null;
  afterVote(room);
}

// 투표(와 테러리스트의 마지막 선택)가 끝난 뒤: 승패 판정 → 다음 밤
function afterVote(room) {
  let w = E.checkWin(room);
  // 하루(밤+낮) 동안 아무도 죽지 않은 날이 6번 이어지면, 더 진행할 수 없는 상황으로 보고 무승부 처리
  if (!w) {
    room.quiet = alivePlayers(room).length === room.cycleAlive ? (room.quiet || 0) + 1 : 0;
    if (room.quiet >= QUIET_LIMIT) w = { kind: 'draw', text: `🤝 ${QUIET_LIMIT}일 연속 아무도 죽지 않아 무승부로 끝났습니다.`, ids: [] };
  } else room.quiet = 0;
  if (w) endGame(room, w);
  else {
    room.day++;
    addChat(room, 'sys', `🌙 ${room.day}일차 밤이 되었습니다.`);
    setPhase(room, 'night');
  }
}

function resetToLobby(room) {
  clearTimeout(room.timer); clearBeg(room); room.lastBoom = null; room.lastPick = null;
  Bots.reset(room);
  room.phase = 'lobby'; room.day = 0; room.winner = null; room.night = null; room.votes = {}; room.voteActs = {};
  room.touches = []; room.pendingWin = null; room.endsAt = 0; room.chat = []; room.seq++; room.jokerBefore = null; room.defense = null; room.confirm = {}; room.wills = []; room.willChats = []; room.rps = null; room.judgeVerdict = null; room.judgeOnly = false; room.speaker = null; room.speakQueue = [];
  for (const p of room.players) {
    p.role = null; p.alive = true; p.s = {}; p.team = null; p.contacted = false; p.destroyed = false; p.exorcised = false; p.blessed = false; p.blessedBy = null; p.loaning = false; p.origRole = null; p.guess = null;
  }
  room.players = room.players.filter((p) => p.bot || p.conns.size > 0); // 접속이 끊긴 사람은 정리(봇은 유지)
  room.specs = (room.specs || []).filter((x) => x.conns.size > 0);
  if (!byId(room, room.hostId)) { const h = room.players.find((x) => !x.bot); if (h) room.hostId = h.id; }
  addChat(room, 'sys', '🔄 새 게임을 준비합니다.');
  for (const p of members(room)) sendBacklog(room, p);
  broadcastState(room);
}

// ---------------------------------------------------------------- 접속 관리
function removeSpec(room, sp) {
  clearTimeout(sp.dcTimer);
  room.specs = room.specs.filter((x) => x !== sp);
  for (const res of sp.conns) { sse(res, 'kicked', {}); try { res.end(); } catch (e) { /* */ } }
  sp.conns.clear();
  broadcastState(room);
}
function removePlayer(room, p) {
  if (p.spec) return removeSpec(room, p);
  clearTimeout(p.dcTimer);
  room.players = room.players.filter((x) => x !== p);
  for (const res of p.conns) { sse(res, 'kicked', {}); try { res.end(); } catch (e) { /* */ } }
  p.conns.clear();
  if (!room.players.some((x) => !x.bot)) { clearTimeout(room.timer); clearBeg(room); rooms.delete(room.code); return; }
  if (room.hostId === p.id) {
    const next = room.players.find((x) => !x.bot && x.conns.size) || room.players.find((x) => !x.bot);
    room.hostId = next.id;
  }
  broadcastState(room);
}
function onDisconnect(room, p) {
  if (p.spec) { // 관전자는 연결이 1분 넘게 끊기면 정리
    if (!room.specs.includes(p) || p.conns.size) return;
    broadcastState(room); clearTimeout(p.dcTimer);
    p.dcTimer = setTimeout(() => { if (rooms.has(room.code) && !p.conns.size && room.specs.includes(p)) removeSpec(room, p); }, 60000);
    return;
  }
  if (!room.players.includes(p)) return; // 이미 나간 사람
  broadcastState(room);
  if (p.conns.size) return;
  clearTimeout(p.dcTimer);
  p.dcTimer = setTimeout(() => {
    if (!rooms.has(room.code) || p.conns.size) return;
    if (room.phase === 'lobby') removePlayer(room, p);
    else if (room.hostId === p.id) {
      const next = room.players.find((x) => !x.bot && x.conns.size);
      if (next) { room.hostId = next.id; broadcastState(room); }
    }
  }, 30000);
}

// ---------------------------------------------------------------- 행동 처리
class Err extends Error {}
const fail = (m) => { throw new Err(m); };

// 🚫 도배 방지: 짧은 시간에 너무 많이 / 같은 말 반복 / 같은 글자 길게 반복하면 막는다 (봇은 제외)
function cleanChat(p, raw) {
  let text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  text = text.replace(/(.)\1{6,}/gu, '$1$1$1$1$1$1'); // "ㅋㅋㅋㅋㅋㅋㅋㅋㅋ…" 는 6개까지만
  if (!text) return '';
  if (p.bot) return text;
  const now = Date.now(), f = (p.flood = p.flood || { times: [], last: '', rep: 0, lastAt: 0, mute: 0 });
  if (now < f.mute) fail(`도배 방지: ${Math.ceil((f.mute - now) / 1000)}초 뒤에 다시 보낼 수 있어요.`);
  f.times = f.times.filter((x) => now - x < 6000);
  if (f.times.length >= 6) { f.mute = now + 10000; f.times = []; fail('도배 방지: 너무 빨리 보내서 10초 동안 말할 수 없어요.'); }
  if (text === f.last && now - f.lastAt < 30000) {
    f.rep++;
    if (f.rep >= 4) { f.mute = now + 10000; f.rep = 0; fail('도배 방지: 같은 말을 계속 보내서 10초 동안 말할 수 없어요.'); }
    if (f.rep >= 2) fail('같은 말을 반복해서 보낼 수 없어요.');
  } else f.rep = 0;
  f.last = text; f.lastAt = now; f.times.push(now); p.lastText = text;
  return text;
}

// 🚨 신고: 여러 명에게 신고되면 잠시 말하지 못하게 하고, 방장에게 알려 준다
function reportAction(room, p, b) {
  const t = members(room).find((x) => x.id === b.target);
  if (!t || t === p || t.bot) fail('신고할 수 없는 대상이에요.');
  room.reports = room.reports || {};
  const set = (room.reports[t.id] = room.reports[t.id] || new Set());
  if (set.has(p.id)) fail('이미 신고했어요.');
  p.reportCount = (p.reportCount || 0) + 1;
  if (p.reportCount > 6) fail('신고를 너무 많이 했어요.');
  set.add(p.id);
  const humans = members(room).filter((x) => !x.bot).length;
  const need = Math.max(2, Math.ceil(humans * 0.3));
  const host = byId(room, room.hostId);
  if (host && host !== p) addChat(room, 'priv', `🚨 ${t.name}님이 신고되었어요 (${set.size}명).${t.lastText ? ` 마지막 말: "${t.lastText.slice(0, 40)}"` : ''}`, null, host.id);
  if (set.size >= need) {
    t.flood = t.flood || { times: [], last: '', rep: 0, lastAt: 0, mute: 0 };
    t.flood.mute = Date.now() + 60000;
    room.reports[t.id] = new Set();
    addChat(room, 'sys', `🚨 ${t.name}님이 여러 명에게 신고되어 60초 동안 말할 수 없어요.`);
  }
}

function specAction(room, p, b) {
  if (b.type === 'report') return reportAction(room, p, b);
  switch (b.type) {
    case 'chat': {
      const now = Date.now();
      if (now - p.lastChat < 250) fail('너무 빨리 보내고 있어요.');
      const text = cleanChat(p, b.text);
      if (!text) return;
      p.lastChat = now;
      addChat(room, 'spec', text, p);
      return;
    }
    case 'unspectate': { // 대기실에서만 다시 참가자로
      if (room.phase !== 'lobby') fail('게임이 시작되면 참가자로 바꿀 수 없어요.');
      if (room.players.length >= MAX_PLAYERS) fail('방이 가득 찼어요.');
      room.specs = room.specs.filter((x) => x !== p);
      p.spec = false; p.alive = true;
      room.players.push(p);
      addChat(room, 'sys', `🎮 ${p.name}님이 참가자로 돌아왔어요.`);
      for (const q of members(room)) sendBacklog(room, q);
      broadcastState(room);
      return;
    }
    case 'leave': removeSpec(room, p); return;
    default: fail('관전자는 할 수 없어요.');
  }
}

function handleAction(room, p, b) {
  room.lastActive = Date.now();
  if (p.spec) return specAction(room, p, b);
  if (b.type === 'report') return reportAction(room, p, b);
  const isHost = room.hostId === p.id;
  switch (b.type) {
    case 'chat': {
      const now = Date.now();
      if (now - p.lastChat < 250) fail('너무 빨리 보내고 있어요.');
      const info = E.chatInfo(room, p);
      if (!info.ch) fail(info.label.replace(/^\S+\s/, ''));
      const text = cleanChat(p, b.text);
      if (!text) return;
      p.lastChat = now;
      addChat(room, info.ch, text, p, info.to);
      if (info.ch === 'all') p.chats = (p.chats || 0) + 1;
      if (p.role === 'beggar' && p.s.met && p.alive && info.ch === 'all') scheduleBeg(room); // 거지가 말했으니 카운트다운 새로 시작
      return;
    }
    case 'boom': {
      if (room.phase !== 'last' || room.lastBoom !== p.id) fail('지금은 선택할 수 없어요.');
      const t = b.target ? byId(room, b.target) : null;
      if (b.target && (!t || !t.alive || t === p)) fail('그 사람은 고를 수 없어요.');
      room.lastPick = t ? t.id : null;
      safeAdvance(room);
      return;
    }
    case 'settings': {
      if (!isHost) fail('방장만 설정을 바꿀 수 있어요.');
      if (room.phase !== 'lobby') fail('게임 중에는 설정을 바꿀 수 없어요.');
      applySettings(room.settings, b.patch || {});
      broadcastState(room);
      return;
    }
    case 'kick': {
      if (!isHost) fail('방장만 내보낼 수 있어요.');
      const sp = room.specs.find((x) => x.id === b.target);
      if (sp) { removeSpec(room, sp); return; } // 관전자는 언제든 내보낼 수 있다
      if (room.phase !== 'lobby') fail('게임 중에는 내보낼 수 없어요.');
      const t = byId(room, b.target);
      if (!t || t.id === p.id) fail('내보낼 수 없는 대상이에요.');
      removePlayer(room, t);
      return;
    }
    case 'addbot': {
      if (!isHost) fail('방장만 봇을 추가할 수 있어요.');
      if (room.phase !== 'lobby') fail('게임 중에는 봇을 추가할 수 없어요.');
      const want = Math.max(1, Math.min(10, Math.round(Number(b.count) || 1)));
      let added = 0;
      for (let i = 0; i < want && room.players.length < MAX_PLAYERS; i++) {
        let n = 1; while (room.players.some((x) => x.name === `봇${n}`)) n++;
        const bot = makePlayer(`봇${n}`); bot.bot = true; room.players.push(bot); added++;
      }
      if (!added) fail('방이 가득 찼어요.');
      broadcastState(room);
      return;
    }
    case 'start': {
      if (!isHost) fail('방장만 시작할 수 있어요.');
      if (room.phase !== 'lobby') fail('이미 시작했어요.');
      if (room.players.length < MIN_PLAYERS) fail(`최소 ${MIN_PLAYERS}명이 필요해요.`);
      startGame(room);
      return;
    }
    case 'skip': {
      if (!isHost) fail('방장만 단계를 넘길 수 있어요.');
      if (!['night', 'day', 'vote', 'defense', 'speak', 'confirm', 'rps'].includes(room.phase)) fail('지금은 넘길 수 없어요.');
      safeAdvance(room);
      return;
    }
    case 'reset': {
      if (!isHost) fail('방장만 다시 시작할 수 있어요.');
      if (room.phase !== 'ended') fail('게임이 끝난 뒤에 할 수 있어요.');
      resetToLobby(room);
      return;
    }
    case 'again': { // 같은 사람들로 바로 다음 판
      if (!isHost) fail('방장만 다시 시작할 수 있어요.');
      if (room.phase !== 'ended') fail('게임이 끝난 뒤에 할 수 있어요.');
      resetToLobby(room);
      if (room.players.length < MIN_PLAYERS) return; // 인원이 모자라면 대기실에 머문다
      startGame(room);
      return;
    }
    case 'spectate': { // 대기실에서 관전자로 옮기기
      if (room.phase !== 'lobby') fail('게임이 시작되기 전에만 관전자로 바꿀 수 있어요.');
      if (room.specs.length >= MAX_SPECS) fail('관전자가 가득 찼어요.');
      if (isHost) {
        const next = room.players.find((x) => x !== p && !x.bot && x.conns.size);
        if (!next) fail('방장은 다른 참가자가 있어야 관전자가 될 수 있어요.');
        room.hostId = next.id;
      }
      room.players = room.players.filter((x) => x !== p);
      p.spec = true;
      room.specs.push(p);
      addChat(room, 'sys', `👀 ${p.name}님이 관전자로 옮겼어요.`);
      for (const q of members(room)) sendBacklog(room, q);
      broadcastState(room);
      return;
    }
    case 'leave': {
      if (room.phase === 'lobby' || room.phase === 'ended') removePlayer(room, p);
      return;
    }
    case 'night': {
      E.setNightAct(room, p, b);
      broadcastState(room);
      return;
    }
    case 'predict': { // 예언가: 첫날 밤 안에 모든 사람의 직업을 예언
      const borne = p.role === 'prophet' && p.snap; // 광대 덕분에 예언가가 된 경우
      if (!borne && p.origRole !== 'prophet') fail('예언가만 예언할 수 있어요.');
      if (borne) { if (!(p.alive && room.phase === 'day' && p.snap.day === room.day)) fail('예언은 예언가가 된 날의 낮 동안에만 입력할 수 있어요.'); }
      else if (!(room.phase === 'night' && room.day === 1)) fail('예언은 첫날 밤에만 입력할 수 있어요.');
      const g = {};
      for (const [id, k] of Object.entries(b.guesses && typeof b.guesses === 'object' ? b.guesses : {})) {
        if (id !== p.id && byId(room, id) && ROLE[k] && (!borne || p.snap.roles[id])) g[id] = k;
      }
      p.guess = g;
      broadcastState(room);
      return;
    }
    case 'vact': {
      E.setVoteAct(room, p, b);
      broadcastState(room);
      return;
    }
    case 'timeadj': {
      if (room.phase !== 'day') fail('아침 시간에만 쓸 수 있어요.');
      if (!p.alive) fail('죽은 사람은 쓸 수 없어요.');
      if (b.dir !== 'short' && b.dir !== 'long') fail('알 수 없는 요청이에요.');
      room.dayAdj = room.dayAdj || {};
      if (room.dayAdj[p.id]) fail('오늘은 이미 시간 조절을 썼어요. (아침마다 한 번)');
      room.dayAdj[p.id] = b.dir;
      const now = Date.now();
      const before = room.endsAt;
      room.endsAt = b.dir === 'short' ? Math.max(now + 1000, room.endsAt - TIME_ADJ_MS) : room.endsAt + TIME_ADJ_MS;
      clearTimeout(room.timer);
      const seq = room.seq;
      room.timer = setTimeout(() => { if (room.seq === seq) safeAdvance(room); }, Math.max(0, room.endsAt - now));
      const left = Math.max(0, Math.ceil((room.endsAt - now) / 1000));
      addChat(room, 'sys', `${b.dir === 'short' ? '⏩' : '⏪'} ${p.name}님이 아침 시간을 ${Math.round(Math.abs(room.endsAt - before) / 1000)}초 ${b.dir === 'short' ? '줄였어요' : '늘렸어요'}. (남은 시간 ${left}초)`);
      broadcastState(room);
      return;
    }
    case 'vote': {
      if (room.phase !== 'vote') fail('지금은 투표 시간이 아니에요.');
      if (!p.alive) fail('죽은 사람은 투표할 수 없어요.');
      const why = E.voteBlockReason(room, p);
      if (why) fail(why);
      if (b.target === null || b.target === '' || b.target === undefined) delete room.votes[p.id];
      else if (b.target === 'skip') { if (!room.settings.abstain) fail('이 방에서는 기권할 수 없어요.'); room.votes[p.id] = 'skip'; }
      else {
        const t = byId(room, b.target);
        if (!t || !t.alive) fail('투표할 수 없는 대상이에요.');
        if (t.id === p.id && !room.settings.selfVote) fail('자신에게는 투표할 수 없어요.');
        if (U.voteImmune(room, t)) fail('오늘은 투표 후보에서 제외된 사람이에요.');
        room.votes[p.id] = t.id;
      }
      broadcastState(room);
      // 투표할 수 있는 모두가 투표했으면 잠시 뒤 바로 개표
      const seq = room.seq;
      const done = () => alivePlayers(room).filter((x) => E.canVote(room, x)).every((x) => room.votes[x.id]);
      if (done()) {
        setTimeout(() => { if (room.seq === seq && room.phase === 'vote' && done()) safeAdvance(room); }, 1500);
      }
      return;
    }
    case 'rps': { // ✊ 내기꾼 가위바위보 (r 바위 / p 보 / s 가위)
      E.rpsPick(room, p, b.sign);
      broadcastState(room);
      const seq = room.seq;
      if (E.rpsDone(room)) setTimeout(() => { if (room.seq === seq && room.phase === 'rps' && E.rpsDone(room)) safeAdvance(room); }, 800);
      return;
    }
    case 'extra': { // ⚔️ 검사·변호사: 최후의 반론 시간에 능력(추가 발언 + 찬반 2표)을 쓸지 고른다
      if (room.phase !== 'defense' || !room.defense) fail('최후의 반론 시간에만 고를 수 있어요.');
      if ((U.dayRole(p) !== 'prosecutor' && U.dayRole(p) !== 'lawyer') || !p.alive) fail('검사·변호사만 쓸 수 있어요.');
      if (room.defense.id === p.id) fail('처형 후보는 쓸 수 없어요.');
      room.extra = room.extra || {}; room.extra[p.id] = !!b.use;
      broadcastState(room);
      return;
    }
    case 'snipe': { // 🔫 저격수: 낮에 한 명의 직업을 맞히면 그 사람이 죽고, 틀리면 자신이 죽는다
      if (room.phase !== 'day') fail('낮(아침 토론) 시간에만 저격할 수 있어요.');
      if (p.role !== 'sniper' || !p.alive) fail('저격수만 쓸 수 있어요.');
      if (p.s.sniped === room.day) fail('오늘은 이미 저격했어요.');
      const t = byId(room, b.target);
      if (!t || !t.alive || t === p) fail('저격할 수 없는 대상이에요.');
      if (!ROLE[b.guess]) fail('맞힐 직업을 골라 주세요.');
      p.s.sniped = room.day;
      const hit = t.role === b.guess;
      const how = '저격으로 인해 사망했습니다.';
      let fizzle = false;
      if (hit) {
        if (t.blessed) { t.blessed = false; fizzle = true; const pr = t.blessedBy ? byId(room, t.blessedBy) : null; if (pr) U.priv(room, pr, `✨ 가호를 내린 ${t.name}님이 공격을 받았지만 가호가 막아 냈습니다! (가호는 사라졌어요)`); }
        else if (U.survive(room, t)) fizzle = true;
      }
      if (fizzle) addChat(room, 'sys', '🔫 저격이 있었지만 아무도 죽지 않았습니다.');
      else killPlayer(room, hit ? t : p, how);
      const w = E.checkWin(room);
      if (w) endGame(room, w); else broadcastState(room);
      return;
    }
    case 'judge': { // ⚖️ 판사: 찬반투표의 결과를 직접 결정 (1회)
      if (room.phase !== 'confirm' || !room.defense) fail('판결은 찬반투표 시간에만 내릴 수 있어요.');
      if (U.dayRole(p) !== 'judge' || !p.alive) fail('판사만 쓸 수 있어요.');
      if (U.usesLeft(room, p, 'judge') <= 0) fail('판결할 수 있는 횟수를 모두 썼어요.');
      if (room.judgeVerdict) fail('이번 처형은 이미 판결이 내려졌어요.');
      if (room.defense.id === p.id) fail('처형 후보는 판결할 수 없어요.');
      if (b.verdict !== 'yes' && b.verdict !== 'no') fail('찬성 또는 반대를 골라 주세요.');
      U.useOne(p, 'judge'); room.judgeVerdict = { ok: b.verdict === 'yes', by: p.id };
      addChat(room, 'sys', `⚖️ 판사 ${p.name}님이 판결을 내렸습니다!`);
      broadcastState(room);
      const seq = room.seq;
      setTimeout(() => { if (room.seq === seq && room.phase === 'confirm') safeAdvance(room); }, 1500);
      return;
    }
    case 'confirm': { // 최후의 반론 뒤 찬성/반대 투표
      if (room.phase !== 'confirm' || !room.defense) fail('지금은 찬반투표 시간이 아니에요.');
      if (!p.alive) fail('죽은 사람은 투표할 수 없어요.');
      if (room.defense.id === p.id) fail('처형 후보는 투표할 수 없어요.');
      if (!E.confirmVoters(room).some((x) => x.id === p.id)) fail('지금은 투표할 수 없어요.');
      if (b.choice === 'yes' || b.choice === 'no') room.confirm[p.id] = b.choice;
      else delete room.confirm[p.id];
      broadcastState(room);
      const seq = room.seq;
      const done = () => E.confirmVoters(room).every((x) => room.confirm[x.id]);
      if (done()) setTimeout(() => { if (room.seq === seq && room.phase === 'confirm' && done()) safeAdvance(room); }, 1500);
      return;
    }
    default: fail('알 수 없는 요청이에요.');
  }
}

Bots.init({ handleAction, rooms });

// ---------------------------------------------------------------- 보안
// 보안 헤더: 다른 사이트가 화면을 끼워 넣거나(클릭재킹) 외부 스크립트를 불러오지 못하게 막는다
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function secHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer'); // 주소에 든 접속 코드가 다른 곳으로 새지 않게
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
// 아주 단순한 요청 횟수 제한 (IP 기준). 한도: [시간(ms), 최대 횟수]
const RATE = { create: [60000, 8], join: [60000, 60], action: [10000, 300], events: [60000, 120], check: [60000, 120] };
const hits = new Map();
function limited(ip, kind) {
  if (process.env.NME_NO_RATE) return false; // 시험용
  const [win, max] = RATE[kind], key = kind + '|' + ip, now = Date.now();
  let h = hits.get(key);
  if (!h || now - h.t > win) { h = { t: now, n: 0 }; hits.set(key, h); }
  return ++h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now - h.t > 120000) hits.delete(k); }, 60000).unref();
const MAX_ROOMS = 300, MAX_CONNS_PER_IP = 120;
const ipConns = new Map();
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---------------------------------------------------------------- HTTP
const INDEX = path.join(__dirname, 'index.html');
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) { reject(new Err('잘못된 요청이에요.')); return; }
    req.on('data', (c) => { d += c; if (d.length > 20000) { reject(new Err('요청이 너무 커요.')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new Err('잘못된 요청이에요.')); } });
    req.on('error', reject);
  });
}
function cleanName(v) { return String(v || '').replace(/\s+/g, ' ').trim().slice(0, 10); }
function auth(code, token) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) return {};
  const p = typeof token === 'string' && token.length === 32 ? members(room).find((x) => safeEq(x.token, token)) : null;
  return { room, p };
}

const server = http.createServer(async (req, res) => {
  try {
    secHeaders(req, res);
    const ip = clientIp(req);
    if (req.headers['x-forwarded-proto'] === 'http' && req.method === 'GET') { // https 로만 쓰도록
      res.writeHead(301, { Location: 'https://' + (req.headers.host || '') + req.url }); return res.end();
    }
    if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: '허용되지 않는 요청이에요.' });
    if ((req.url || '').length > 600) return json(res, 414, { error: '주소가 너무 길어요.' });
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /' || route === 'GET /index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(INDEX));
    }
    if (route === 'GET /healthz') return json(res, 200, { ok: true, rooms: rooms.size });
    if (route === 'GET /api/meta') {
      return json(res, 200, { roles: ROLES, teams: TEAM_NAMES, limits: LIMITS, caps: Object.fromEntries(ROLES.map((r) => [r.key, roleCap(r.key)])), min: MIN_PLAYERS, max: MAX_PLAYERS });
    }
    if (route === 'GET /api/rooms') {
      if (limited(ip, 'check')) return json(res, 429, { error: '요청이 너무 많아요. 잠시 후 다시 해 주세요.' });
      const list = [...rooms.values()].filter((r) => r.settings.publicRoom && r.phase === 'lobby' && r.players.length < MAX_PLAYERS)
        .sort((a, b) => b.lastActive - a.lastActive).slice(0, 30)
        .map((r) => ({ code: r.code, host: (byId(r, r.hostId) || {}).name || '', count: r.players.length, max: MAX_PLAYERS }));
      return json(res, 200, { rooms: list });
    }
    if (route === 'GET /api/check') {
      if (limited(ip, 'check')) return json(res, 429, { error: '요청이 너무 많아요. 잠시 후 다시 해 주세요.' });
      const { p } = auth(url.searchParams.get('code'), url.searchParams.get('token'));
      return json(res, p ? 200 : 404, { ok: !!p });
    }
    if (route === 'GET /api/events') {
      const { room, p } = auth(url.searchParams.get('code'), url.searchParams.get('token'));
      if (!p) return json(res, 404, { error: '방을 찾을 수 없어요.' });
      if (limited(ip, 'events')) return json(res, 429, { error: '요청이 너무 많아요. 잠시 후 다시 해 주세요.' });
      if ((ipConns.get(ip) || 0) >= MAX_CONNS_PER_IP || p.conns.size >= 6) return json(res, 429, { error: '접속이 너무 많아요.' });
      ipConns.set(ip, (ipConns.get(ip) || 0) + 1);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      clearTimeout(p.dcTimer);
      p.conns.add(res);
      sendBacklog(room, p);
      sse(res, 'state', viewFor(room, p));
      broadcastState(room);
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* */ } }, 15000);
      req.on('close', () => {
        ipConns.set(ip, Math.max(0, (ipConns.get(ip) || 1) - 1));
        clearInterval(hb);
        p.conns.delete(res);
        if (rooms.has(room.code)) onDisconnect(room, p);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/create') {
      if (limited(ip, 'create')) return json(res, 429, { error: '방을 너무 많이 만들었어요. 잠시 후 다시 해 주세요.' });
      if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: '지금은 방이 가득 찼어요. 잠시 후 다시 해 주세요.' });
      const b = await readBody(req);
      const name = cleanName(b.name);
      if (!name) return json(res, 400, { error: '이름을 입력해 주세요.' });
      const { room, player } = createRoom(name);
      return json(res, 200, { code: room.code, token: player.token, id: player.id });
    }
    if (req.method === 'POST' && url.pathname === '/api/join') {
      if (limited(ip, 'join')) return json(res, 429, { error: '시도가 너무 많아요. 잠시 후 다시 해 주세요.' });
      const b = await readBody(req);
      const name = cleanName(b.name);
      if (!name) return json(res, 400, { error: '이름을 입력해 주세요.' });
      const room = rooms.get(String(b.code || '').trim().toUpperCase());
      if (!room) return json(res, 404, { error: '방을 찾을 수 없어요. 코드를 확인해 주세요.' });
      const asSpec = room.phase !== 'lobby' || b.spectate === true; // 이미 시작된 방은 관전자로 입장
      if (!asSpec && room.players.length >= MAX_PLAYERS) return json(res, 400, { error: '방이 가득 찼어요.' });
      if (asSpec && (room.specs || []).length >= MAX_SPECS) return json(res, 400, { error: '관전자가 가득 찼어요.' });
      if (members(room).some((x) => x.name.toLowerCase() === name.toLowerCase())) return json(res, 400, { error: '같은 이름이 이미 있어요.' });
      const p = makePlayer(name);
      if (asSpec) { p.spec = true; room.specs.push(p); addChat(room, 'sys', `👀 ${name}님이 관전자로 들어왔어요.`); }
      else room.players.push(p);
      room.lastActive = Date.now();
      broadcastState(room);
      return json(res, 200, { code: room.code, token: p.token, id: p.id, spectator: !!p.spec });
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      if (limited(ip, 'action')) return json(res, 429, { error: '너무 빨리 누르고 있어요.' });
      const b = await readBody(req);
      const { room, p } = auth(b.code, b.token);
      if (!p) return json(res, 404, { error: '방을 찾을 수 없어요.' });
      handleAction(room, p, b);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (e instanceof Err || e instanceof E.GameError) return json(res, 400, { error: e.message });
    console.error(e);
    try { json(res, 500, { error: '서버 오류가 발생했어요.' }); } catch (x) { /* */ }
  }
});

server.requestTimeout = 20000; server.headersTimeout = 10000; // 느리게 보내며 붙잡는 접속 차단

// 오래 방치된 방 정리
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = room.players.some((p) => p.conns.size);
    if (!anyone && now - room.lastActive > 30 * 60 * 1000) { clearTimeout(room.timer); clearBeg(room); rooms.delete(code); }
  }
}, 5 * 60 * 1000).unref();

module.exports = { server, rooms, advance, startGame, E, createRoom, makePlayer, setPhase, handleAction, viewFor };
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log(`NME 서버 실행 중: http://localhost:${PORT}`));
}
