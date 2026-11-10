'use strict';
// 밤 시작 / 밤 결과 처리
const { ROLE } = require('../roles');
const U = require('./util');
const AB = require('./abilities');

function startNight(room) {
  room.night = { acts: {} };
  room.touches = [];
  for (const p of U.alive(room)) {
    // 암살자: 2일차 밤부터 매일 밤 랜덤 타겟 (접선 전)
    if (p.role === 'assassin' && !p.contacted && room.day >= 2) {
      const cand = U.alive(room).filter((x) => x !== p && !U.inMafiaChat(x));
      p.s.target = cand.length ? U.pick(cand).id : null;
      if (p.s.target) U.priv(room, p, `🎯 오늘의 타겟은 ${U.byId(room, p.s.target).name}님입니다. 이 사람이 죽으면 마피아와 접선합니다.`);
    }
    if (p.s.blockNight === room.day) U.priv(room, p, '💋 유혹당해서 오늘 밤에는 능력을 사용할 수 없습니다.');
  }
}

// 암살자가 접선했는지 확인 (밤 결과 직후, 투표 직후 두 번)
function checkAssassins(room) {
  for (const p of room.players) {
    if (p.alive && p.role === 'assassin' && !p.contacted && p.s.target) {
      const t = U.byId(room, p.s.target);
      if (t && !t.alive) { U.contact(room, p, t); p.s.target = null; }
    }
  }
}

function copyRoleNote(room, p, role) {
  U.setRole(room, p, role);
  U.priv(room, p, `🎭 당신의 직업은 이제 "${U.roleName(role)}"입니다! (${ROLE[role].desc})`);
}

function jokerShuffle(room, joker) {
  const newRole = U.pick(['citizen', 'mafia']);
  const list = U.alive(room);
  const pool = U.shuffle(list.map((p) => (p === joker ? newRole : p.role)));
  list.forEach((p, i) => { U.setRole(room, p, pool[i], true); });
  for (const p of room.players) { p.s.known = {}; }
  U.sys(room, '🃏 광대의 장난으로 살아있는 모든 사람의 직업이 뒤섞였습니다! 자신의 직업을 다시 확인하세요.');
  for (const p of list) {
    U.priv(room, p, `🎭 새 직업: ${U.roleName(p.role)} — ${ROLE[p.role].desc}`);
    if (U.inMafiaChat(p)) {
      const mates = list.filter((x) => x !== p && U.inMafiaChat(x));
      U.priv(room, p, `🔪 마피아 팀: ${U.names(mates) || '(없음)'}`);
    }
  }
}

function resolveNight(room) {
  const day = room.day;
  const acts = room.night.acts;
  const priv = (p, t) => U.priv(room, p, t);
  const pub = [];            // 아침 공지
  const deaths = [];         // {p, how}
  const revives = [];        // {t, by, type}
  const attacks = [];        // {kind, by, t}
  const healBy = {};         // 살려진 사람 id -> 살린 사람들
  const addHeal = (t, by) => { (healBy[t.id] = healBy[t.id] || []).push(by); };
  const isHealed = (t, kind) => (healBy[t.id] || []).some((h) => kind !== 'assassin' || h !== t); // 암살자는 상대의 자기 치료를 무시
  const guard = {};          // 보호받는 사람 id -> 경호원
  const nightDeadIds = new Set();
  const guardNotes = [];     // 경호원이 지키던 사람이 공격받아 죽은 기록

  // ---- 1. 실제로 실행되는 행동 모으기
  let list = [];
  for (const p of U.alive(room)) {
    const a = acts[p.id]; if (!a || !a.target) continue;
    const opt = AB.nightOptions(room, p, a.mode); if (!opt) continue;
    const t = U.byId(room, a.target);
    if (!t || !opt.targets.includes(t.id)) continue;
    list.push({ p, t, mode: opt.mode || a.mode, text: a.text });
  }
  // ---- 2. (암살자는 접선 뒤 직접 죽이는 능력이라 5번에서 공격으로 처리)
  // ---- 3. 닌자: 대상 맞바꾸기
  const ninja = list.find((x) => x.p.role === 'ninja');
  if (ninja) {
    const A = ninja.p, B = ninja.t;
    for (const x of list) {
      if (x === ninja) continue;
      if (x.t === A) x.t = B; else if (x.t === B) x.t = A;
    }
    U.touch(room, A, B);
  }
  list = list.filter((x) => x.p.role !== 'ninja');

  // ---- 4. 마피아 공격 투표 정리
  const atk = list.filter((x) => U.canAttackAsMafia(room, x.p));
  list = list.filter((x) => !atk.includes(x));
  if (atk.length) {
    const cnt = {};
    for (const x of atk) cnt[x.t.id] = (cnt[x.t.id] || 0) + 1;
    const top = Math.max(...Object.values(cnt));
    const tid = U.pick(Object.keys(cnt).filter((k) => cnt[k] === top));
    const shooter = U.pick(atk.filter((x) => x.t.id === tid)).p;
    attacks.push({ kind: 'mafia', by: shooter, t: U.byId(room, tid) });
    U.touch(room, shooter, U.byId(room, tid));
  }

  // ---- 5. 직업별 효과
  for (const x of list) {
    const { p, t } = x;
    switch (p.role) {
      case 'spy': {
        priv(p, `🕵 조사 결과: ${t.name}님의 직업은 "${U.roleName(U.shownRole(t))}"입니다.`);
        p.s.known = p.s.known || {}; p.s.known[t.id] = U.shownRole(t);
        if (t.role === 'soldier') priv(t, `🕵 스파이 ${p.name}님이 당신을 조사했습니다!`), priv(p, '⚠ 군인에게 정체를 들켰습니다!');
        if (U.isMafiaKnown(t)) U.contact(room, p, t);
        U.touch(room, p, t); break;
      }
      case 'police':
        priv(p, `🔍 조사 결과: ${t.name}님은 ${U.shownRole(t) === 'mafia' ? '마피아입니다.' : '마피아가 아닙니다.'}`);
        U.touch(room, p, t); break;
      case 'ghost':
        t.s.silenceDay = day; t.s.noVoteDay = day; p.s.lastScare = { id: t.id, day };
        priv(t, '😨 겁을 먹었습니다. 오늘은 말도 투표도 할 수 없습니다.');
        if (U.isMafiaKnown(t)) U.contact(room, p, t);
        U.touch(room, p, t); break;
      case 'thug':
        if (t.role === 'soldier') { p.s.noVoteDay = day; priv(p, '👊 군인을 협박해서 오히려 자신의 투표권을 잃었습니다!'); }
        else { t.s.noVoteDay = day; priv(t, '👊 협박당했습니다. 오늘은 투표할 수 없습니다.'); }
        U.touch(room, p, t); break;
      case 'doppelganger':
        p.s.disguise = t.role; priv(p, `🎭 이제 조사 결과에서 "${U.roleName(t.role)}"(으)로 보입니다.`);
        if (U.isMafiaKnown(t)) U.contact(room, p, t);
        U.touch(room, p, t); break;
      case 'rich':
        U.touch(room, p, t);
        if (t.role === 'beggar') {
          p.s.meetDay = day; t.s.meetDay = day; t.s.met = true;
          priv(p, '💰 그 사람은 거지였습니다! 2일 뒤 둘 다 살아있으면 우승합니다.');
          priv(t, '🎉 부자를 만났습니다! 이제 말하고 투표할 수 있고, 투표로 죽을 수도 있어요. 12~17초마다 채팅을 해야 하며 안 하면 "한푼 줍쇼"가 자동으로 전송돼요. 2일 뒤 둘 다 살아있으면 우승합니다.');
        } else priv(p, `💰 ${t.name}님은 거지가 아닙니다.`);
        break;
      case 'medium':
        priv(p, `🔮 성불 결과: ${t.name}님의 직업은 "${U.roleName(t.role)}"였습니다. (이제 ${t.name}님은 말할 수 없습니다)`);
        t.exorcised = true; break;
      case 'detective': p.s.detA = t.id; U.touch(room, p, t); break;
      case 'reporter':
        p.s.reportUsed = true; p.s.report = { target: t.id, day: day + 1 };
        priv(p, `📰 ${t.name}님에 대한 속보를 준비했습니다. 다음 날 아침에 공개됩니다.`);
        U.touch(room, p, t); break;
      case 'programmer':
        priv(t, `📨 익명의 메시지: ${String(x.text || '(내용 없음)').slice(0, 100)}`);
        p.s.progTarget = t.id; priv(p, `📨 ${t.name}님에게 익명 메시지를 보냈습니다.`);
        U.touch(room, p, t); break;
      case 'terrorist': p.s.boomNight = t.id; U.touch(room, p, t); break;
      case 'volunteer': p.s.volPick = t.id; break;
      case 'bodyguard': guard[t.id] = p; U.touch(room, p, t); break;
      case 'doctor':
        addHeal(t, p); if (t.id === p.id) p.s.lastSelfHeal = day;
        U.touch(room, p, t); break;
      case 'angel':
        p.s.angelUsed = true; U.touch(room, p, t);
        if (x.mode === 'revive') revives.push({ t, by: p, type: 'angel' });
        else if (U.teamOf(t) === 'citizen') addHeal(t, p);
        else priv(p, `😇 ${t.name}님은 시민 팀이 아니어서 소생에 실패했습니다.`);
        break;
      case 'priest':
        p.s.priestUsed = true; revives.push({ t, by: p, type: 'priest' }); break;
      case 'scientist':
        U.touch(room, p, t);
        p.s.potionUsed = x.mode === 'heal' ? 'heal' : 'kill'; // 하나를 쓰면 나머지는 쓸 수 없다
        if (x.mode === 'heal') { addHeal(t, p); priv(p, `⚗ ${t.name}님에게 살리는 물약을 사용했습니다. (이제 물약을 더 쓸 수 없습니다)`); }
        else { attacks.push({ kind: 'potion', by: p, t }); priv(p, `⚗ ${t.name}님에게 죽이는 물약을 사용했습니다. (이제 물약을 더 쓸 수 없습니다)`); }
        break;
      case 'destroyer': attacks.push({ kind: 'destroy', by: p, t }); U.touch(room, p, t); break;
      case 'assassin': attacks.push({ kind: 'assassin', by: p, t }); U.touch(room, p, t); break;
      default: break;
    }
  }
  // 미치광이: 능력을 쓰기로 한 밤에만, 자신을 포함한 아무나 랜덤으로 죽인다
  for (const p of U.alive(room)) {
    if (p.role !== 'madman') continue;
    const a = acts[p.id];
    if (!a || a.mode !== 'on' || !AB.nightOptions(room, p, 'on')) continue; // 안 쓰기로 했거나 유혹당함
    const t = U.pick(U.alive(room));
    attacks.push({ kind: 'madman', by: p, t });
    U.touch(room, p, t);
  }

  // ---- 6. 공격 처리 (파괴 → 물약 → 미치광이 → 마피아 순서)
  const order = { destroy: 0, potion: 1, madman: 2, mafia: 3, assassin: 4 };
  attacks.sort((a, b) => order[a.kind] - order[b.kind]);
  const kill = (victim, how, by, kind) => {
    victim.alive = false; nightDeadIds.add(victim.id);
    deaths.push({ p: victim, how });
    if (kind === 'destroy') victim.destroyed = true;
    // 테러리스트: 자신을 죽인 사람을 지목했다면 함께 자폭
    if (victim.role === 'terrorist' && by && victim.s.boomNight === by.id && by.alive && by !== victim) {
      by.alive = false; nightDeadIds.add(by.id);
      deaths.push({ p: by, how: '테러리스트의 자폭에 휘말려 사망했습니다.' });
    }
  };
  const HOW = { mafia: '마피아에게 살해당했습니다.', potion: '정체불명의 공격으로 사망했습니다.', madman: '정체불명의 공격으로 사망했습니다.', destroy: '정체불명의 공격으로 사망했습니다.', assassin: '정체불명의 공격으로 사망했습니다.' };
  let mafiaFailMsg = null;
  for (const at of attacks) {
    let t = at.t;
    if (!t.alive) continue;
    if (at.kind === 'mafia' && t.role === 'couple') {
      const partner = U.alive(room).find((x) => x !== t && x.role === 'couple');
      if (partner) t = partner;
    }
    let fail = null;
    if (at.kind !== 'destroy') {
      if (at.kind === 'mafia' && (t.role === 'ghost' || t.role === 'hermit')) fail = 'immune';
      else if (at.kind === 'mafia' && t.role === 'soldier' && !t.s.shieldUsed) { t.s.shieldUsed = true; fail = 'soldier'; }
      else if (isHealed(t, at.kind)) fail = 'heal';
    }
    if (fail) {
      if (at.kind === 'mafia') mafiaFailMsg = fail === 'heal' ? '🩺 마피아의 습격이 있었지만 누군가가 살려냈습니다!' : '🛡 마피아의 습격이 있었지만 아무도 죽지 않았습니다.';
      continue;
    }
    const g = guard[t.id] || guard[at.t.id];
    kill(t, HOW[at.kind], at.by, at.kind);
    if (g && at.by) guardNotes.push({ g, victim: t, by: at.by });
  }

  // ---- 7. 사망 후속 처리
  for (const p of room.players) {
    if (p.role === 'programmer' && p.alive && p.s.progTarget) {
      const t = U.byId(room, p.s.progTarget);
      if (t && !t.alive && nightDeadIds.has(t.id)) priv(p, `📨 메시지를 보낸 ${t.name}님이 사망했습니다. 진짜 직업은 "${U.roleName(t.role)}"였습니다.`);
    }
    delete p.s.progTarget;
  }
  checkAssassins(room);

  // ---- 8. 부활
  const revived = [];
  for (const r of revives) {
    if (r.t.alive || r.t.destroyed) { priv(r.by, `✨ ${r.t.name}님은 부활할 수 없습니다.`); continue; }
    if (r.type === 'angel' && U.teamOf(r.t) !== 'citizen') { priv(r.by, `😇 ${r.t.name}님은 시민 팀이 아니어서 부활에 실패했습니다.`); continue; }
    r.t.alive = true; revived.push(r.t);
  }

  // ---- 9. 지원자: 자신에게 능력을 쓴 사람의 직업 얻기
  for (const v of U.alive(room)) {
    if (v.role !== 'volunteer' || !v.s.volPick) continue;
    const t = U.byId(room, v.s.volPick); v.s.volPick = null;
    if (!t) continue;
    const touched = room.touches.some((c) => c.from === t.id && c.to === v.id);
    if (touched && ROLE[t.role].team === 'citizen' && t.role !== 'volunteer' && t.role !== 'couple') copyRoleNote(room, v, t.role);
  }

  // ---- 10. 아침 공지
  U.sys(room, `☀️ ${day}일차 아침이 밝았습니다.`);
  if (mafiaFailMsg) U.sys(room, mafiaFailMsg);
  for (const d of deaths) U.io.kill(room, d.p, d.how);
  for (const gn of guardNotes) {
    U.sys(room, `🛡 경호원이 지키던 ${gn.victim.name}님이 공격으로 사망했습니다! 공격한 사람은 ${gn.by.name}님입니다.`);
    priv(gn.g, `🛡 지키던 ${gn.victim.name}님이 사망했습니다. (공격한 ${gn.by.name}님이 모두에게 공개되었습니다)`);
  }
  for (const t of revived) U.sys(room, `✨ ${t.name}님이 부활했습니다!`);
  if (!deaths.length && !mafiaFailMsg && !revived.length) U.sys(room, '고요한 밤이었습니다. 아무 일도 일어나지 않았습니다.');

  // 도굴꾼 (1일차 아침)
  if (day === 1) {
    for (const g of U.alive(room)) {
      if (g.role !== 'gravedigger') continue;
      const src = deaths.map((d) => d.p).find((p) => p !== g && !p.alive);
      let role = src ? src.role : 'citizen';
      if (['couple', 'beggar', 'rich', 'gravedigger', 'joker'].includes(role)) role = 'citizen';
      copyRoleNote(room, g, role);
    }
  }
  // 광대 (2일차 아침): 그 전에 죽었다면 아무 일도 일어나지 않는다
  if (day === 2) {
    const joker = U.alive(room).find((x) => x.role === 'joker');
    if (joker) jokerShuffle(room, joker);
  }

  // 기자 속보
  for (const p of room.players) {
    if (p.role === 'reporter' && p.s.report && p.s.report.day === day) {
      if (p.alive) {
        const t = U.byId(room, p.s.report.target);
        U.sys(room, `📰 속보! ${t.name}님의 직업은 "${U.roleName(U.shownRole(t))}"입니다.`);
      }
      p.s.report = null;
    }
  }

  // 거지·부자 우승 확인
  const rich = room.players.find((x) => x.role === 'rich' && x.s.meetDay != null);
  const beggar = room.players.find((x) => x.role === 'beggar' && x.s.meetDay != null);
  if (rich && beggar) {
    if (!rich.alive || !beggar.alive) { rich.s.meetDay = null; beggar.s.meetDay = null; }
    else if (day >= rich.s.meetDay + 2) {
      room.pendingWin = { kind: 'duo', ids: [rich.id, beggar.id], text: `💰 부자 ${rich.name}님과 거지 ${beggar.name}님이 우승했습니다!` };
    }
  }
  room.night = null;
}

module.exports = { startNight, resolveNight, checkAssassins };
