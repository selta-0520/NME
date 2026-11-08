'use strict';
// 봇 두뇌. 봇은 사람과 똑같이 handleAction 으로만 행동하고, 남의 직업을 몰래 보지 않습니다.
// 알 수 있는 것: 자기 직업·팀원, 자기가 조사한 결과, 공개된 죽음/투표 수, 채팅 내용(사람 채팅의 이름·의심 표현 읽기)
const crypto = require('crypto');
const { ROLE } = require('./roles');
const E = require('./engine');
const { U } = E;

let deps = null;
function init(d) { deps = d; }

// once: 1회용 능력을 쓸 확률(밤마다) / skip: 행동을 빼먹을 확률 / mistake: 마피아가 실수로 팀원을 고를 확률
const LEVELS = {
  easy:    { skip: 0.15, mistake: 0.12, speak: 0.5,  once: 0.35, bandwagon: 4,  noise: 28, coordinate: false, claim: true, listen: false, deceive: false, sacrifice: false, threat: false, follow: false },
  normal:  { skip: 0.04, mistake: 0.03, speak: 0.7,  once: 0.5,  bandwagon: 7,  noise: 12, coordinate: true,  claim: true, listen: true,  deceive: false, sacrifice: false, threat: true,  follow: true },
  hard:    { skip: 0.01, mistake: 0,    speak: 0.85, once: 0.6,  bandwagon: 9,  noise: 6,  coordinate: true,  claim: true, listen: true,  deceive: true,  sacrifice: false, threat: true,  follow: true },
  extreme: { skip: 0,    mistake: 0,    speak: 0.95, once: 0.7,  bandwagon: 11, noise: 2,  coordinate: true,  claim: true, listen: true,  deceive: true,  sacrifice: true,  threat: true,  follow: true },
};
const LEVEL_KEYS = Object.keys(LEVELS);
const LINES = ['누가 수상한지 얘기해 봐요', '저는 시민이에요', '조용한 사람이 의심스러워요', '일단 지켜볼게요', '투표는 신중하게 해요', '어제 밤에 무슨 일이 있었죠?', '의심 가는 사람 있어요?'];
const ONCE = new Set(['reporter', 'priest', 'angel', 'scientist']);
const HOSTILE = new Set(['thug', 'ghost', 'assassin', 'terrorist', 'reporter']);
const FRIENDLY = new Set(['doctor', 'bodyguard', 'volunteer', 'angel', 'scientist']);

const rnd = (a) => a[crypto.randomInt(a.length)];
const chance = (p) => Math.random() < p;
const lv = (room) => LEVELS[room.settings.botLevel] || LEVELS.normal;
function bm(room) { if (!room.bm) room.bm = { sus: {}, claims: [], cop: {}, hunt: {}, acc: {} }; return room.bm; }
function bmem(p) { if (!p.b) p.b = { checks: {}, pending: null, toAnnounce: null, faked: false }; return p.b; }
function act(room, p, body) { try { deps.handleAction(room, p, body); return true; } catch (e) { return false; } }
const say = (room, p, text) => act(room, p, { type: 'chat', text });
const nCop = (room) => Object.keys(bm(room).cop).filter((id) => { const q = U.byId(room, id); return q && q.alive; }).length;

function tallyOf(room) {
  const t = {};
  for (const [vid, tid] of Object.entries(room.votes)) {
    if (tid === 'skip') continue;
    const v = U.byId(room, vid); if (!v) continue;
    t[tid] = (t[tid] || 0) + E.weight(v);
  }
  return t;
}

function addClaim(room, by, target, result) {
  const m = bm(room);
  m.cop[by.id] = true;
  m.claims.push({ by: by.id, target: target.id, result });
}

// 이 사람이 얼마나 수상한가 (높을수록 의심)
function suspicion(room, me, c, tally) {
  const L = lv(room), m = bm(room), b = bmem(me);
  let s = m.sus[c.id] || 0;
  if (b.checks[c.id] === 'mafia') s += 200; else if (b.checks[c.id] === 'clean') s -= 200;
  const n = nCop(room);
  for (const cl of m.claims) {
    if (cl.target !== c.id) continue;
    const by = U.byId(room, cl.by);
    if (!by || !by.alive || by === me) continue;
    const w = n <= 1 ? 60 : 15;
    s += cl.result === 'mafia' ? w : -w;
  }
  if (n > 1 && m.cop[c.id]) s += 20; // 경찰이 둘 이상이면 서로 거짓말일 수 있음
  if (tally && tally[c.id]) s += tally[c.id] * L.bandwagon;
  return s;
}

// ------------------------------------------------------------ 채팅 읽기 (사람 채팅)
function hear(room, m) {
  const L = lv(room);
  if (!L.listen) return;
  const sp = U.byId(room, m.from); if (!sp) return;
  const text = m.text, M = bm(room);
  const accuse = /마피아|의심|수상|범인|처형/.test(text);
  const defend = /아니|시민|믿|확실|무고/.test(text);
  const sayCop = /경찰/.test(text) && /(저는|제가|내가|나는|저 경찰|난 )/.test(text);
  if (sayCop) M.cop[sp.id] = true;
  for (const q of U.alive(room)) {
    if (q.id === sp.id || !text.includes(q.name)) continue;
    if (accuse && !defend) { M.sus[q.id] = (M.sus[q.id] || 0) + 12; (M.acc[sp.id] = M.acc[sp.id] || {})[q.id] = 1; if (sayCop) addClaim(room, sp, q, 'mafia'); }
    else if (defend && !accuse) { M.sus[q.id] = (M.sus[q.id] || 0) - 8; if (sayCop) addClaim(room, sp, q, 'clean'); }
  }
}

// ------------------------------------------------------------ 밤
function pickNight(room, p, opt, mode) {
  const L = lv(room), m = bm(room), b = bmem(p);
  const cands = opt.targets.map((id) => U.byId(room, id)).filter(Boolean);
  const best = (fn) => {
    let bs = -1e9, bc = [];
    for (const c of cands) { const s = fn(c) + Math.random() * L.noise; if (s > bs) { bs = s; bc = [c]; } else if (s === bs) bc.push(c); }
    return rnd(bc).id;
  };
  const sus = (c) => suspicion(room, p, c, null);
  const role = p.role, team = U.teamOf(p);

  if (U.canAttackAsMafia(room, p)) {
    if (L.coordinate) { // 이미 팀원이 고른 대상이 있으면 따라간다
      const picks = Object.entries(room.night.acts)
        .filter(([pid, a]) => a.target && pid !== p.id && U.byId(room, pid) && U.canAttackAsMafia(room, U.byId(room, pid)))
        .map(([, a]) => a.target).filter((t) => opt.targets.includes(t));
      if (picks.length) return rnd(picks);
    }
    const mates = U.alive(room).filter((x) => U.inMafiaChat(x));
    const acc = (c) => mates.reduce((n, t) => n + ((m.acc[c.id] && m.acc[c.id][t.id]) || 0), 0);
    return best((c) => (m.hunt[c.id] ? 80 : 0) + (L.threat && m.cop[c.id] ? 60 : 0) + (L.threat ? acc(c) * 25 : 0) - (L.threat ? (m.sus[c.id] || 0) * 0.2 : 0) - ((m.fail && m.fail[c.id]) || 0) * 100);
  }
  if (role === 'police') return best((c) => (b.checks[c.id] ? -100 : 0) + sus(c));
  if (team === 'mafia') { // 마피아 팀 특수직업: 팀원은 피하고 경찰 행세하는 사람을 노린다
    const non = cands.filter((c) => !U.inMafiaChat(c));
    const pool = non.length ? non : cands;
    let bs = -1e9, bc = [];
    for (const c of pool) { const s = (m.hunt[c.id] ? 60 : 0) + (m.cop[c.id] ? 30 : 0) + Math.random() * L.noise; if (s > bs) { bs = s; bc = [c]; } }
    return rnd(bc).id;
  }
  if (HOSTILE.has(role) || (role === 'scientist' && mode === 'kill')) return best((c) => sus(c));
  if (FRIENDLY.has(role)) {
    return best((c) => -sus(c) + (m.cop[c.id] && nCop(room) === 1 ? 40 : 0) + (b.checks[c.id] === 'clean' ? 30 : 0)
      + (c.id === p.id ? (role === 'doctor' ? 8 : 0) : 0));
  }
  if ((role === 'priest' || (role === 'angel' && mode === 'revive')) && room.settings.revealOnDeath) {
    return best((c) => (c.role && ROLE[c.role].team === 'citizen' ? 50 : 0));
  }
  if (role === 'spy' || role === 'detective' || role === 'rich') return best((c) => (b.checks[c.id] ? -50 : 0));
  return rnd(cands).id;
}

function chooseMode(room, p, opt) {
  const L = lv(room), b = bmem(p);
  const has = (k) => opt.modes.some((x) => x.key === k);
    if (p.role === 'scientist') {
    const knownMafia = U.alive(room).some((x) => b.checks[x.id] === 'mafia');
    if (knownMafia && has('kill')) return 'kill';
    if (has('heal') && (!has('kill') || chance(0.6))) return 'heal';
    return opt.modes[0].key;
  }
  if (p.role === 'angel') {
    const deadOk = room.players.some((x) => !x.alive && !x.destroyed);
    return deadOk && chance(0.6) ? 'revive' : 'save';
  }
  return opt.mode;
}

function botNight(room, p) {
  const L = lv(room);
  let opt = E.AB.nightOptions(room, p);
  if (!opt) return;
  if (chance(L.skip)) return;
  if (ONCE.has(p.role) && !chance(L.once)) return;
  let mode = opt.mode;
  if (opt.modes) {
    mode = chooseMode(room, p, opt);
    if (mode !== opt.mode) { act(room, p, { type: 'night', target: null, mode }); opt = E.AB.nightOptions(room, p, mode); if (!opt) return; }
  }
  if (!opt.targets.length) return;
  const id = pickNight(room, p, opt, mode);
  const body = { type: 'night', target: id, mode };
  if (opt.text) body.text = rnd(LINES);
  const okAct = act(room, p, body);
  if (okAct && U.canAttackAsMafia(room, p)) { const mm = bm(room); (mm.tried = mm.tried || {})[room.day] = id; }
  if (okAct && (p.role === 'police' || p.role === 'spy')) bmem(p).pending = { id, role: p.role };
}

// ------------------------------------------------------------ 낮
function settleChecks(room, p) {
  const b = bmem(p), L = lv(room);
  if (!b.pending) return;
  const t = U.byId(room, b.pending.id); const role = b.pending.role; b.pending = null;
  if (!t) return;
  const shown = U.shownRole(t);
  b.checks[t.id] = shown === 'mafia' ? 'mafia' : 'clean';
  if (role === 'spy') { if (shown === 'police' || shown === 'doctor') bm(room).hunt[t.id] = true; return; }
  if (role === 'police' && shown === 'mafia' && L.claim) b.toAnnounce = t.id;
}

function botSay(room, p) {
  const L = lv(room), m = bm(room), mafia = U.inMafiaChat(p);
  const others = U.alive(room).filter((x) => x !== p);
  if (mafia && L.deceive && room.day >= 2 && !bmem(p).faked && chance(0.5)) { // 가짜 경찰 행세
    const c = others.filter((x) => !U.inMafiaChat(x));
    if (c.length) { const t = rnd(c); bmem(p).faked = true; addClaim(room, p, t, 'mafia'); return say(room, p, `저는 경찰이에요. ${t.name}님을 조사했는데 마피아였어요!`); }
  }
  if (chance(0.75) && others.length) {
    const pool = mafia ? others.filter((x) => !U.inMafiaChat(x)) : others;
    if (pool.length) {
      let bs = -1e9, bc = null;
      for (const c of pool) { const s = suspicion(room, p, c, null) + Math.random() * 6; if (s > bs) { bs = s; bc = c; } }
      if (bc && (bs > 8 || mafia)) {
        if (L.listen) m.sus[bc.id] = (m.sus[bc.id] || 0) + 3; // 말이 퍼지면 다른 봇도 조금 의심
        const why = (m.vsus && m.vsus[bc.id]) ? ' 지난번에 시민을 처형하자고 했었잖아요.' : (m.acc && Object.values(m.acc).some((o) => o[bc.id]) ? ' 다른 분들도 의심하고 있어요.' : '');
        return say(room, p, `${bc.name}님이 수상해요.${why} 투표를 고려해 봐요.`);
      }
    }
  }
  return say(room, p, rnd(LINES));
}

// ------------------------------------------------------------ 투표
function botVote(room, p) {
  const L = lv(room), m = bm(room);
  const vo = E.AB.voteOptions(room, p);
  if (vo && vo.targets.length && chance(0.7)) {
    const cands = vo.targets.map((id) => U.byId(room, id)).filter(Boolean);
    let pool = cands;
    if (U.inMafiaChat(p)) { const non = cands.filter((c) => !U.inMafiaChat(c)); if (non.length) pool = non; }
    act(room, p, { type: 'vact', target: rnd(pool).id });
  }
  if (!E.canVote(room, p)) return;
  if (chance(L.skip)) return void act(room, p, { type: 'vote', target: 'skip' });
  const tally = tallyOf(room);
  const mafia = U.inMafiaChat(p);
  const alive = U.alive(room);
  let cands = alive.filter((x) => x !== p);
  if (!cands.length) return;
  if (mafia && !chance(L.mistake)) {
    if (L.sacrifice) { // 팀원이 곧 처형될 게 확실하면 같이 투표해서 의심을 피한다
      const need = Math.ceil(alive.filter((x) => E.canVote(room, x)).length / 2);
      const lead = cands.filter((c) => U.inMafiaChat(c) && (tally[c.id] || 0) >= need).sort((a, b) => (tally[b.id] || 0) - (tally[a.id] || 0))[0];
      if (lead) return void act(room, p, { type: 'vote', target: lead.id });
    }
    const non = cands.filter((c) => !U.inMafiaChat(c));
    if (non.length) cands = non;
    if (L.follow) { // 이미 팀원이 찍은 대상이 있으면 같이 찍어 표를 모은다
      const tv = {};
      for (const [vid, tid] of Object.entries(room.votes)) {
        const vv = U.byId(room, vid);
        if (vv && vv !== p && U.inMafiaChat(vv) && cands.some((c) => c.id === tid)) tv[tid] = (tv[tid] || 0) + 1;
      }
      const top = Object.entries(tv).sort((a, b) => b[1] - a[1])[0];
      if (top) return void act(room, p, { type: 'vote', target: top[0] });
    }
  }
  let bs = -1e9, bc = [];
  for (const c of cands) {
    let s = suspicion(room, p, c, tally) + Math.random() * L.noise;
    if (mafia) {
      if (L.threat && m.cop[c.id]) s += 40;
      for (const cl of m.claims) { const by = U.byId(room, cl.by); if (cl.target === c.id && cl.result === 'mafia' && by && U.inMafiaChat(by)) s += 30; }
    }
    if (s > bs) { bs = s; bc = [c]; } else if (s === bs) bc.push(c);
  }
  act(room, p, { type: 'vote', target: rnd(bc).id });
}

// ------------------------------------------------------------ 단계 시작 시 호출
function schedule(room) {
  const seq = room.seq, phase = room.phase, L = lv(room);
  const sec = phase === 'night' ? room.settings.nightSec : phase === 'day' ? room.settings.daySec : room.settings.voteSec;
  for (const p of room.players) {
    if (!p.bot || !p.alive) continue;
    const at = (a, b, fn) => setTimeout(() => {
      if (room.seq !== seq || !deps.rooms.has(room.code) || !p.alive) return;
      try { fn(); } catch (e) { console.error('봇 오류', e); }
    }, 300 + (a + Math.random() * (b - a)) * sec * 1000);
    if (phase === 'night') at(0.1, 0.75, () => botNight(room, p));
    else if (phase === 'day') {
      settleChecks(room, p);
      const b = bmem(p);
      if (b.toAnnounce) {
        const t = U.byId(room, b.toAnnounce); b.toAnnounce = null;
        if (t && t.alive) at(0.05, 0.3, () => { addClaim(room, p, t, 'mafia'); say(room, p, `저는 경찰이에요. ${t.name}님을 조사했는데 마피아였어요!`); });
      } else if (chance(L.speak)) at(0.1, 0.9, () => { if (E.chatInfo(room, p).ch === 'all') botSay(room, p); });
    } else if (phase === 'vote') at(0.15, 0.85, () => botVote(room, p));
  }
}

// 죽은 사람의 직업이 공개되면 거기서 단서를 얻는다 (직업 공개 설정이 켜진 경우에만)
function afterResolve(room, beforeIds, voteSnap) {
  const m = bm(room); m.vsus = m.vsus || {}; m.fail = m.fail || {};
  if (!voteSnap) { // 밤: 마피아가 노렸는데 아무도 죽지 않았다면, 그 대상은 공격이 안 통하는 사람일 수 있다
    const t = m.tried && m.tried[room.day];
    const anyDied = beforeIds.some((id) => { const d = U.byId(room, id); return d && !d.alive; });
    if (t) { if (!anyDied) m.fail[t] = (m.fail[t] || 0) + 1; else m.fail[t] = 0; }
  }
  if (!room.settings.revealOnDeath) return;
  for (const id of beforeIds) {
    const d = U.byId(room, id); if (!d || d.alive || !d.role) continue;
    const team = ROLE[d.role].team;
    if (voteSnap) {
      for (const [vid, tid] of Object.entries(voteSnap)) {
        if (tid !== d.id) continue;
        if (team === 'citizen') { m.sus[vid] = (m.sus[vid] || 0) + 22; m.vsus[vid] = 1; }
        else if (team === 'mafia') m.sus[vid] = (m.sus[vid] || 0) - 14;
      }
    }
    for (const cl of m.claims) { // 죽은 사람이 한 경찰 주장의 진위가 드러남
      if (cl.by !== d.id) continue;
      const t = U.byId(room, cl.target); if (!t) continue;
      if (d.role === 'police') m.sus[t.id] = (m.sus[t.id] || 0) + (cl.result === 'mafia' ? 90 : -40);
      else m.sus[t.id] = (m.sus[t.id] || 0) + (cl.result === 'mafia' ? -25 : 10);
    }
    m.claims = m.claims.filter((cl) => cl.by !== d.id);
    delete m.cop[d.id];
  }
}

// 누군가 죽을 때마다 호출: 죽은 사람은 더 이상 경찰 후보로 치지 않는다
function onDeath(room, p) {
  if (!room.bm) return;
  delete room.bm.cop[p.id];
}

function reset(room) { room.bm = null; for (const p of room.players) p.b = null; }

module.exports = { init, schedule, hear, reset, afterResolve, onDeath, LEVEL_KEYS };
