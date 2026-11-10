'use strict';
// NME (New Mafia Extended Mix) 서버 — 외부 패키지 없이 Node.js 기본 기능만 사용합니다.
// 실행: node server.js  →  http://localhost:3000
// 게임 규칙(직업 능력)은 engine/ 폴더에 있습니다.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROLES, ROLE, TEAM_NAMES } = require('./roles');
const E = require('./engine');
const { U } = E;
const Bots = require('./bots');

const PORT = Number(process.env.PORT) || 3000;
const QUIET_LIMIT = 6;
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
  mafiaSpecialMax: [0, 10],
  citizenSpecialMax: [0, 40],
  neutralMax: [0, 10],
};

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
  return {
    nightSec: 40,
    daySec: 90,
    voteSec: 30,
    mafiaSpecialMax: 2,
    citizenSpecialMax: 12,
    neutralMax: 2,
    revealOnDeath: true,
    botLevel: 'normal',
    selfVote: true,
    forcedRoles: [],
    enabledRoles: ROLES.filter((r) => !r.fixed).map((r) => r.key),
  };
}
function applySettings(s, patch) {
  for (const k of Object.keys(LIMITS)) {
    if (patch[k] !== undefined) s[k] = clamp(patch[k], LIMITS[k], s[k]);
  }
  if (patch.revealOnDeath !== undefined) s.revealOnDeath = !!patch.revealOnDeath;
  if (Bots.LEVEL_KEYS.includes(patch.botLevel)) s.botLevel = patch.botLevel;
  if (patch.selfVote !== undefined) s.selfVote = !!patch.selfVote;
  const ok = new Set(ROLES.filter((r) => !r.fixed).map((r) => r.key));
  const clean = (l) => [...new Set(l)].filter((k) => ok.has(k));
  const prevEn = s.enabledRoles.slice(), prevFo = s.forcedRoles.slice();
  const hasEnabledPatch = Array.isArray(patch.enabledRoles), hasForcedPatch = Array.isArray(patch.forcedRoles);
  if (hasEnabledPatch) s.enabledRoles = fixPair(clean(patch.enabledRoles), prevEn);
  if (hasForcedPatch) {
    s.forcedRoles = fixPair(clean(patch.forcedRoles), prevFo);
    for (const k of s.forcedRoles) if (!s.enabledRoles.includes(k)) s.enabledRoles.push(k); // 필수 지정하면 자동으로 사용 설정
  } else if (hasEnabledPatch) s.forcedRoles = s.forcedRoles.filter((k) => s.enabledRoles.includes(k));
}
// 거지와 부자는 "거지 & 부자" 한 묶음: 한쪽만 바뀌어 오면 이전 상태를 보고 둘 다 켜거나 둘 다 끈다
function fixPair(list, prev) {
  const b = list.includes('beggar'), r = list.includes('rich');
  if (b === r) return list;
  const base = list.filter((k) => k !== 'beggar' && k !== 'rich');
  const prevBoth = prev.includes('beggar') && prev.includes('rich');
  return prevBoth ? base : [...base, 'beggar', 'rich'];
}

// ---------------------------------------------------------------- 방
function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += chars[crypto.randomInt(chars.length)];
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
    chat: [], msgId: 0, winner: null, lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return { room, player: host };
}

// ---------------------------------------------------------------- 전송
function sse(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { /* 끊긴 연결 */ }
}
function sendToPlayer(p, event, data) { for (const res of p.conns) sse(res, event, data); }
const pubMsg = (m) => ({ id: m.id, ch: m.ch, name: m.name, text: m.text, t: m.t });

function addChat(room, ch, text, from, to) {
  const m = { id: ++room.msgId, ch, name: from ? from.name : '', from: from ? from.id : null, to: to || null,
    text, t: Date.now(), night: room.phase === 'night' };
  room.chat.push(m);
  if (room.chat.length > 400) room.chat.shift();
  for (const p of room.players) if (E.canSeeMsg(room, p, m)) sendToPlayer(p, 'chat', pubMsg(m));
  if (from && !from.bot && ch === 'all' && (room.phase === 'day' || room.phase === 'vote')) Bots.hear(room, { from: from.id, text });
  return m;
}
function sendBacklog(room, p) {
  const list = room.chat.filter((m) => E.canSeeMsg(room, p, m)).slice(-200).map(pubMsg);
  sendToPlayer(p, 'backlog', list);
}

function killPlayer(room, p, how) {
  p.alive = false;
  const rev = room.settings.revealOnDeath ? ` (직업: ${roleName(p.role)})` : '';
  addChat(room, 'sys', `💀 ${p.name}님이 ${how}${rev}`);
  Bots.onDeath(room, p, how);
}
// 엔진이 쓰는 출력 함수 연결
U.io.sys = (room, text) => addChat(room, 'sys', text);
U.io.priv = (room, p, text) => addChat(room, 'priv', text, null, p.id);
U.io.kill = killPlayer;

function viewFor(room, p) {
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
  };
  if (inGame) {
    v.me = E.meView(room, p);
    if (room.phase === 'day') v.dayAdj = (room.dayAdj && room.dayAdj[p.id]) || null;
    if (room.phase === 'last' && room.lastBoom) { const t = byId(room, room.lastBoom); v.last = { terrorist: room.lastBoom, name: t ? t.name : '' }; }
    if (p.alive && p.role === 'beggar' && p.s.met && room.begAt && (room.phase === 'day' || room.phase === 'vote')) v.begAt = room.begAt;
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
  if (room.phase !== 'day' && room.phase !== 'vote') return null;
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
  for (const p of room.players) if (p.conns.size) sendToPlayer(p, 'state', viewFor(room, p));
}

// ---------------------------------------------------------------- 게임 진행
function setPhase(room, phase) {
  clearTimeout(room.timer);
  room.phase = phase;
  room.seq++;
  const s = room.settings;
  const sec = phase === 'night' ? s.nightSec : phase === 'day' ? s.daySec : phase === 'vote' ? s.voteSec : phase === 'last' ? LAST_SEC : 0;
  if (sec) {
    room.endsAt = Date.now() + sec * 1000;
    const seq = room.seq;
    room.timer = setTimeout(() => { if (room.seq === seq) safeAdvance(room); }, sec * 1000);
  } else room.endsAt = 0;
  if (phase === 'night') E.startNight(room);
  if (phase === 'day') room.dayAdj = {};
  if (phase === 'night') room.cycleAlive = alivePlayers(room).length;
  if (phase === 'vote') { room.votes = {}; room.voteActs = {}; }
  broadcastState(room);
  if (phase === 'day' || phase === 'vote') scheduleBeg(room); else clearBeg(room);
  if (phase === 'night' || phase === 'day' || phase === 'vote' || phase === 'last') Bots.schedule(room);
}

function startGame(room) {
  Bots.reset(room);
  clearBeg(room); room.lastBoom = null; room.lastPick = null;
  const skipped = E.assignRoles(room);
  room.quiet = 0;
  room.day = 1; room.winner = null; room.votes = {}; room.voteActs = {};
  addChat(room, 'sys', '🎭 게임이 시작되었습니다! 직업이 배정되었어요.');
  if (skipped && skipped.length) addChat(room, 'sys', `⚠ 인원이 부족해 필수 직업 중 ${skipped.map(roleName).join(', ')}은(는) 이번 판에 넣지 못했어요.`);
  for (const p of room.players) {
    U.priv(room, p, `🎭 당신의 직업은 "${roleName(p.role)}" (${TEAM_NAMES[ROLE[p.role].team]}) 입니다.`);
    if (U.inMafiaChat(p)) {
      const mates = room.players.filter((x) => x !== p && U.inMafiaChat(x));
      U.priv(room, p, `🔪 마피아 팀: ${U.names(mates) || '(없음)'}`);
    }
    if (p.role === 'couple') {
      const m = room.players.find((x) => x !== p && x.role === 'couple');
      if (m) U.priv(room, p, `💕 당신의 커플은 ${m.name}님입니다.`);
    }
  }
  addChat(room, 'sys', '🌙 1일차 밤이 되었습니다.');
  setPhase(room, 'night');
  for (const p of room.players) sendBacklog(room, p);
}

function endGame(room, w) {
  room.winner = w;
  addChat(room, 'sys', w.text);
  const list = room.players.map((p) => `${p.name}(${roleName(p.role)}${p.alive ? '' : '·사망'})`).join(', ');
  addChat(room, 'sys', `📋 직업 공개: ${list}`);
  setPhase(room, 'ended');
  for (const p of room.players) sendBacklog(room, p);
}

// 단계 넘기기에서 오류가 나면 기록만 하고, 게임이 멈추지 않도록 다음 단계로 강제 이동을 시도한다
function safeAdvance(room) {
  try { advance(room); } catch (e) {
    console.error('[단계 진행 오류]', e && e.stack || e);
    room.lastBoom = null;
    try { if (room.phase !== 'lobby' && room.phase !== 'ended') { room.day = room.day || 1; setPhase(room, room.phase === 'night' ? 'day' : room.phase === 'day' ? 'vote' : 'night'); } } catch (e2) { console.error('[복구 실패]', e2 && e2.stack || e2); }
  }
}
function advance(room) {
  if (room.phase === 'night') {
    const before = alivePlayers(room).map((x) => x.id);
    E.resolveNight(room);
    Bots.afterResolve(room, before, null);
    const w = E.checkWin(room);
    if (w) endGame(room, w); else setPhase(room, 'day');
  } else if (room.phase === 'day') {
    addChat(room, 'sys', '🗳 투표 시간입니다. 처형할 사람을 선택하세요.');
    setPhase(room, 'vote');
  } else if (room.phase === 'vote') {
    const before = alivePlayers(room).map((x) => x.id), snap = Object.assign({}, room.votes);
    E.resolveVote(room);
    Bots.afterResolve(room, before, snap);
    if (room.lastBoom && alivePlayers(room).length) { // 처형된 테러리스트가 함께 죽을 사람을 고르는 시간
      addChat(room, 'sys', '💣 처형된 테러리스트가 함께 죽을 사람을 고르고 있습니다…');
      setPhase(room, 'last');
      return;
    }
    room.lastBoom = null;
    afterVote(room);
  } else if (room.phase === 'last') {
    const before = alivePlayers(room).map((x) => x.id);
    E.resolveBoom(room, room.lastPick || null);
    Bots.afterResolve(room, before, {});
    afterVote(room);
  }
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
  room.touches = []; room.pendingWin = null; room.endsAt = 0; room.chat = []; room.seq++;
  for (const p of room.players) {
    p.role = null; p.alive = true; p.s = {}; p.team = null; p.contacted = false; p.destroyed = false; p.exorcised = false;
  }
  room.players = room.players.filter((p) => p.bot || p.conns.size > 0); // 접속이 끊긴 사람은 정리(봇은 유지)
  if (!byId(room, room.hostId)) { const h = room.players.find((x) => !x.bot); if (h) room.hostId = h.id; }
  addChat(room, 'sys', '🔄 새 게임을 준비합니다.');
  for (const p of room.players) sendBacklog(room, p);
  broadcastState(room);
}

// ---------------------------------------------------------------- 접속 관리
function removePlayer(room, p) {
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

function handleAction(room, p, b) {
  room.lastActive = Date.now();
  const isHost = room.hostId === p.id;
  switch (b.type) {
    case 'chat': {
      const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!text) return;
      const now = Date.now();
      if (now - p.lastChat < 250) fail('너무 빨리 보내고 있어요.');
      p.lastChat = now;
      const info = E.chatInfo(room, p);
      if (!info.ch) fail(info.label.replace(/^\S+\s/, ''));
      addChat(room, info.ch, text, p);
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
      if (!['night', 'day', 'vote'].includes(room.phase)) fail('지금은 넘길 수 없어요.');
      safeAdvance(room);
      return;
    }
    case 'reset': {
      if (!isHost) fail('방장만 다시 시작할 수 있어요.');
      if (room.phase !== 'ended') fail('게임이 끝난 뒤에 할 수 있어요.');
      resetToLobby(room);
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
      room.endsAt = b.dir === 'short' ? Math.max(now + 1000, room.endsAt - 5000) : room.endsAt + 5000;
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
      else if (b.target === 'skip') room.votes[p.id] = 'skip';
      else {
        const t = byId(room, b.target);
        if (!t || !t.alive) fail('투표할 수 없는 대상이에요.');
        if (t.id === p.id && !room.settings.selfVote) fail('자신에게는 투표할 수 없어요.');
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
    default: fail('알 수 없는 요청이에요.');
  }
}

Bots.init({ handleAction, rooms });

// ---------------------------------------------------------------- HTTP
const INDEX = path.join(__dirname, 'index.html');
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 20000) { reject(new Err('요청이 너무 커요.')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new Err('잘못된 요청이에요.')); } });
    req.on('error', reject);
  });
}
function cleanName(v) { return String(v || '').replace(/\s+/g, ' ').trim().slice(0, 10); }
function auth(code, token) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) return {};
  const p = room.players.find((x) => x.token === token);
  return { room, p };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /' || route === 'GET /index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(INDEX));
    }
    if (route === 'GET /healthz') return json(res, 200, { ok: true, rooms: rooms.size });
    if (route === 'GET /api/meta') {
      return json(res, 200, { roles: ROLES, teams: TEAM_NAMES, limits: LIMITS, min: MIN_PLAYERS, max: MAX_PLAYERS });
    }
    if (route === 'GET /api/check') {
      const { p } = auth(url.searchParams.get('code'), url.searchParams.get('token'));
      return json(res, p ? 200 : 404, { ok: !!p });
    }
    if (route === 'GET /api/events') {
      const { room, p } = auth(url.searchParams.get('code'), url.searchParams.get('token'));
      if (!p) return json(res, 404, { error: '방을 찾을 수 없어요.' });
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
        clearInterval(hb);
        p.conns.delete(res);
        if (rooms.has(room.code)) onDisconnect(room, p);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/create') {
      const b = await readBody(req);
      const name = cleanName(b.name);
      if (!name) return json(res, 400, { error: '이름을 입력해 주세요.' });
      const { room, player } = createRoom(name);
      return json(res, 200, { code: room.code, token: player.token, id: player.id });
    }
    if (req.method === 'POST' && url.pathname === '/api/join') {
      const b = await readBody(req);
      const name = cleanName(b.name);
      if (!name) return json(res, 400, { error: '이름을 입력해 주세요.' });
      const room = rooms.get(String(b.code || '').trim().toUpperCase());
      if (!room) return json(res, 404, { error: '방을 찾을 수 없어요. 코드를 확인해 주세요.' });
      if (room.phase !== 'lobby') return json(res, 400, { error: '이미 게임이 시작된 방이에요.' });
      if (room.players.length >= MAX_PLAYERS) return json(res, 400, { error: '방이 가득 찼어요.' });
      if (room.players.some((x) => x.name.toLowerCase() === name.toLowerCase())) return json(res, 400, { error: '같은 이름이 이미 있어요.' });
      const p = makePlayer(name);
      room.players.push(p);
      room.lastActive = Date.now();
      broadcastState(room);
      return json(res, 200, { code: room.code, token: p.token, id: p.id });
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
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
