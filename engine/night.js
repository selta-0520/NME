'use strict';
// 밤 시작 / 밤 결과 처리
const { ROLE, ROLES, LOANABLE } = require('../roles');
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

// 다시 나눠 줄 때 뽑을 수 있는 직업 (광대·짝이 필요한 직업·게임 시작 때만 의미 있는 직업은 제외)
const REROLL_SKIP = new Set(['joker', 'rich']); // 거지는 부자와 함께(2자리), 커플도 2자리로 뽑는다
function rerollRoles(room, list, joker, newRole) {
  const s = room.settings, enabled = new Set(s.enabledRoles || []);
  const teamOfRole = (k) => ROLE[k].team;
  const slots = { mafia: 0, citizen: 0, neutral: 0 };
  for (const p of list) {
    if (p === joker) continue; // 광대 자리는 시민/마피아가 그대로 받는다
    slots[teamOfRole(p.role)]++; // 팀별 인원은 그대로, 직업만 새로 뽑는다
  }
  const maxOf = (k) => (k === 'mafia' || k === 'citizen' ? 99 : (s.roleMax && s.roleMax[k] != null ? Math.max(1, s.roleMax[k] | 0) : 1));
  const out = [];
  for (const team of ['mafia', 'citizen', 'neutral']) {
    const used = {};
    const on = (k) => enabled.has(k) || k === 'mafia' || k === 'citizen';
    const poolFor = (useEnabled) => ROLES.filter((r) => r.team === team && !REROLL_SKIP.has(r.key) && (!useEnabled || (on(r.key) && (r.key !== 'beggar' || enabled.has('rich'))))).map((r) => r.key);
    const size = (k) => (k === 'couple' || k === 'beggar' ? 2 : 1);
    let left = slots[team];
    while (left > 0) {
      const ok = (k) => (used[k] || 0) < maxOf(k) && size(k) <= left;
      let c = poolFor(true).filter(ok);
      if (!c.length) c = poolFor(false).filter(ok);
      const k = c.length ? U.pick(c) : (team === 'mafia' ? 'mafia' : 'citizen');
      used[k] = (used[k] || 0) + 1; left -= size(k);
      if (k === 'couple') out.push({ team, k }, { team, k });
      else if (k === 'beggar') out.push({ team, k: 'beggar' }, { team, k: 'rich' });
      else out.push({ team, k });
    }
  }
  return out;
}

function jokerShuffle(room, joker) {
  const newRole = U.pick(['citizen', 'mafia']);
  const list = U.alive(room);
  const before = list.map((p) => `${p.name}(${U.roleName(p.role)})`); // 섞이기 전 직업
  if (room.settings.jokerMode === 'reroll') { // 팀별 인원은 유지하고, 직업은 전체 직업에서 새로 뽑아 나눠 준다
    const picked = U.shuffle(rerollRoles(room, list, joker, newRole));
    const byTeam = { mafia: [], citizen: [], neutral: [] };
    for (const x of picked) byTeam[x.team].push(x.k);
    // 광대는 시민/마피아로, 나머지는 원래 팀 칸을 받는다
    const order = U.shuffle(list.slice());
    for (const p of order) {
      const team = p === joker ? ROLE[newRole].team : ROLE[p.role].team;
      const k = p === joker ? newRole : byTeam[team].shift();
      U.setRole(room, p, k, true);
    }
  } else {
    const pool = U.shuffle(list.map((p) => (p === joker ? newRole : p.role)));
    list.forEach((p, i) => { U.setRole(room, p, pool[i], true); });
  }
  for (const p of room.players) { p.s.known = {}; p.snap = null; }
  for (const p of list) { // 광대로 새 예언가가 된 사람은 오늘 낮 동안 예언할 수 있다 (그 시점의 직업 기준으로 판정)
    if (p.role === 'prophet' && p.origRole !== 'prophet') { p.guess = null; p.snap = { day: room.day, roles: Object.fromEntries(list.filter((x) => x !== p).map((x) => [x.id, x.role])) }; }
  }
  U.sys(room, room.settings.jokerMode === 'reroll' ? '🃏 광대의 장난으로 살아있는 모든 사람의 직업이 새로 배정되었습니다! 자신의 직업을 다시 확인하세요.' : '🃏 광대의 장난으로 살아있는 모든 사람의 직업이 뒤섞였습니다! 자신의 직업을 다시 확인하세요.');
  room.jokerBefore = before.join(', '); // 게임이 끝난 뒤 공개용으로 보관
  if (room.settings.jokerReveal === 'shuffle') U.sys(room, `📜 섞이기 전의 원래 직업: ${room.jokerBefore}`);
  for (const p of list) { if (p.role === 'follower') U.assignMaster(room, p); } // 섞인 신봉자는 새 주인을 받는다
  for (const p of list) {
    U.priv(room, p, `🎭 새 직업: ${U.roleName(p.role)} — ${ROLE[p.role].desc}`);
    if (p.role === 'prophet' && p.snap) U.priv(room, p, '🔮 광대 덕분에 예언가가 되었어요! 오늘 낮이 끝나기 전에 살아 있는 사람들의 직업을 예언하세요. 지금 직업을 기준으로 게임이 끝났을 때 절반 이상 맞으면 우승해요.');
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
  const witnesses = [], executors = [], attacked = {}; // 목격자·유언집행자의 대상, 공격받은 사람 id -> 공격자
  room.wills = [];

  // ---- 0. 훔친 능력을 쓰는 도둑은 이번 밤 동안 그 직업으로 처리한다 (끝나면 되돌림)
  const swapped = [];
  for (const p of U.alive(room)) {
    if (p.role !== 'thief' || !p.s.loan || p.loaning) continue;
    const a = acts[p.id];
    if (!a || (!a.target && a.mode !== 'on')) continue;
    if (!AB.nightOptions(room, p, a.mode)) continue; // 유혹당함 등
    swapped.push({ p, role: p.role, s: p.s });
    p.role = p.s.loan; p.s = p.s.lnS || {}; p.loaning = true;
  }

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
      case 'inspector': { // 🔎 형사: 직업 후보 3개 (진짜 1 + 가짜 2). 시민·마피아·중립 팀에서 1개씩, 중립이 없는 판이면 시민/마피아 1+2 또는 2+1
        const real = t.role, rt = ROLE[real].team;
        const pickOf = (list) => list[Math.floor(Math.random() * list.length)];
        const hasNeutral = rt === 'neutral' || room.players.some((x) => ROLE[x.role].team === 'neutral');
        const pool = (team) => ROLES.filter((r) => r.team === team && r.key !== real && !(team === 'neutral' && r.key === 'joker' && room.jokerBefore)).map((r) => r.key); // 광대가 섞은 뒤에는 중립 후보에 광대가 나오지 않는다
        const fakes = [];
        if (hasNeutral) {
          for (const team of ['citizen', 'mafia', 'neutral']) if (team !== rt) fakes.push(pickOf(pool(team)));
        } else {
          const cNum = Math.random() < 0.5 ? 1 : 2; // 시민 팀 후보 수 (나머지는 마피아 팀)
          const want = { citizen: cNum, mafia: 3 - cNum };
          want[rt] -= 1; // 진짜가 속한 팀 자리 하나는 진짜가 차지
          for (const team of ['citizen', 'mafia']) for (let i = 0; i < want[team]; i++) fakes.push(pickOf(pool(team).filter((k) => !fakes.includes(k))));
        }
        const list = U.shuffle([real, ...fakes]);
        priv(p, `🔎 ${t.name}님의 직업 후보: ${list.map((k) => ROLE[k].name).join(' / ')} (이 중 하나가 진짜예요)`);
        U.touch(room, p, t); break;
      }
      case 'guardian': t.s.voteImmune = day; priv(p, `🛡 ${t.name}님을 오늘 투표 후보에서 제외했습니다.`); U.touch(room, p, t); break;
      case 'witness': witnesses.push({ p, t }); U.touch(room, p, t); break;
      case 'executor': executors.push({ p, t }); U.touch(room, p, t); break;
      case 'bettor': U.touch(room, p, t); break; // 가위바위보는 밤이 끝날 때 따로 진행
      case 'poisoner': {
        if (!p.contacted) { // 마피아를 찾으면 접선
          U.touch(room, p, t);
          if (U.isMafiaKnown(t)) U.contact(room, p, t); else priv(p, `🤝 ${t.name}님은 마피아가 아니었습니다.`);
          break;
        }
        t.s.poison = { day, by: p.id };
        priv(p, `🧪 ${t.name}님에게 독을 걸었습니다. ${day + 1}일차 낮에 죽어요. (그 사이 밤에 치료받으면 살아나요)`);
        priv(t, `🧪 몸이 이상합니다… 독에 중독된 것 같아요! 오늘 밤 안에 치료받지 못하면 ${day + 1}일차 낮에 죽습니다.`);
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
        t.exorcised = true;
        priv(t, '👼 영매에게 성불당했습니다. (이제 말할 수 없습니다)');
        break;
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
        p.s.angelUsed = true; p.s.blessT = t.id; t.blessed = true; t.blessedBy = p.id;
        priv(p, `✨ ${t.name}님에게 성스러운 가호를 내렸습니다! (이번 판 동안 첫 공격 1번을 막아 줍니다)`);
        U.touch(room, p, t); break;
      case 'priest':
        p.s.priestUsed = true; revives.push({ t, by: p, type: 'priest' }); break;
      case 'scientist':
        U.touch(room, p, t);
        p.s.potionUsed = x.mode === 'heal' ? 'heal' : 'kill'; // 하나를 쓰면 나머지는 쓸 수 없다
        if (x.mode === 'heal') { addHeal(t, p); priv(p, `⚗ ${t.name}님에게 살리는 물약을 사용했습니다. (이제 물약을 더 쓸 수 없습니다)`); }
        else { attacks.push({ kind: 'potion', by: p, t }); priv(p, `⚗ ${t.name}님에게 죽이는 물약을 사용했습니다. (이제 물약을 더 쓸 수 없습니다)`); }
        break;
      case 'destroyer': p.s.destroyUsed = (p.s.destroyUsed || 0) + 1; attacks.push({ kind: 'destroy', by: p, t }); U.touch(room, p, t); break;
      case 'gambler': p.s.gamble = t.id; break;
      case 'evil': { // 능력은 없고 접선만 한다
        U.touch(room, p, t);
        if (U.isMafiaKnown(t)) U.contact(room, p, t); else priv(p, `🤝 ${t.name}님은 마피아가 아니었습니다.`);
        break;
      }
      case 'forger': case 'agitator': {
        if (!p.contacted) { // 마피아를 찾으면 접선
          U.touch(room, p, t);
          if (U.isMafiaKnown(t)) U.contact(room, p, t); else priv(p, `🤝 ${t.name}님은 마피아가 아니었습니다.`);
          break;
        }
        const fake = x.mode && x.mode !== 'real' && ROLE[x.mode] ? x.mode : null;
        p.s.reportUsed = true; p.s.report = { target: t.id, day: day + 1, fake };
        priv(p, `📰 ${t.name}님에 대한 속보를 준비했습니다.${fake ? ` 공개될 직업: "${U.roleName(fake)}" (거짓)` : ''} 다음 날 아침에 공개됩니다.`);
        U.touch(room, p, t); break;
      }
      case 'thief': {
        p.s.stolenIds = (p.s.stolenIds || []).concat(t.id);
        U.touch(room, p, t);
        if (LOANABLE.includes(t.role)) {
          p.s.loan = t.role; p.s.lnS = {};
          priv(p, `🧤 ${t.name}님의 직업은 "${U.roleName(t.role)}"였고, 그 능력을 훔쳤습니다! 다음 밤부터 딱 1번 쓸 수 있어요. (${ROLE[t.role].desc})`);
        } else priv(p, `🧤 ${t.name}님의 직업은 "${U.roleName(t.role)}"였지만, 훔쳐서 쓸 수 있는 밤 능력이 없었습니다. (이 사람은 다시 고를 수 없어요)`);
        break;
      }
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

  // 독: 지난 밤에 중독된 사람은 이번 밤에 죽는다 (치료받으면 살아남는다)
  const poisoned = [];
  for (const t of U.alive(room)) {
    const po = t.s.poison;
    if (!po || po.day >= day) continue;
    poisoned.push(t); t.s.poison = null;
    attacks.push({ kind: 'poison', by: U.byId(room, po.by) || null, t });
  }

  // ---- 6. 공격 처리 (파괴 → 물약 → 미치광이 → 마피아 순서)
  const order = { destroy: 0, potion: 1, madman: 2, poison: 2.5, mafia: 3, assassin: 4 };
  attacks.sort((a, b) => order[a.kind] - order[b.kind]);
  const kill = (victim, how, by, kind) => {
    victim.alive = false; nightDeadIds.add(victim.id);
    deaths.push({ p: victim, how });
    if (kind === 'destroy') victim.destroyed = true;
    // 테러리스트: 자신을 죽인 사람을 지목했다면 함께 자폭
    if (victim.role === 'terrorist' && by && victim.s.boomNight === by.id && by.alive && by !== victim && !U.survive(room, by)) {
      by.alive = false; nightDeadIds.add(by.id);
      deaths.push({ p: by, how: '테러리스트의 자폭에 휘말려 사망했습니다.' });
    }
  };
  const HOW = { mafia: '마피아에게 살해당했습니다.', potion: '정체불명의 공격으로 사망했습니다.', madman: '정체불명의 공격으로 사망했습니다.', destroy: '파괴당했습니다. (마피아의 공격이 아닙니다)', assassin: '정체불명의 공격으로 사망했습니다.', poison: '독에 중독되어 사망했습니다.' };
  let mafiaFailMsg = null;
  for (const at of attacks) {
    let t = at.t;
    if (at.by && !attacked[t.id]) attacked[t.id] = at.by; // 목격자용: 공격받은 사람 기록
    if (!t.alive) continue;
    if (at.kind === 'mafia' && t.role === 'couple') {
      const partner = U.alive(room).find((x) => x !== t && x.role === 'couple');
      if (partner) { t = partner; if (at.by && !attacked[t.id]) attacked[t.id] = at.by; }
    }
    const g = guard[t.id] || guard[at.t.id]; // 경호원: 지키던 사람 대신 공격을 받고, 공격자의 정체를 밝힌다
    if (g && g.alive && g !== t && at.by) { guardNotes.push({ g, victim: t, by: at.by }); t = g; }
    let fail = null;
    if (at.kind !== 'destroy') {
      if (at.kind === 'mafia' && (t.role === 'ghost' || t.role === 'hermit')) fail = 'immune';
      else if (at.kind === 'mafia' && t.role === 'soldier' && !t.s.shieldUsed) { t.s.shieldUsed = true; fail = 'soldier'; }
      else if (isHealed(t, at.kind)) fail = 'heal';
    }
    if (!fail && t.blessed) { // 사제의 가호: 첫 공격 1번 무효 (공격 종류 무관)
      t.blessed = false; fail = 'bless';
      const pr = t.blessedBy ? U.byId(room, t.blessedBy) : null;
      if (pr) priv(pr, `✨ 가호를 내린 ${t.name}님이 공격을 받았지만 가호가 막아 냈습니다! (가호는 사라졌어요)`);
    }
    if (!fail && U.survive(room, t)) fail = 'survive'; // 생존자: 2번까지 버틴다 (능력 무시도 통하지 않음)
    if (fail) {
      if (at.kind === 'mafia') mafiaFailMsg = fail === 'heal' ? '🩺 마피아의 습격이 있었지만 누군가가 살려냈습니다!' : '🛡 마피아의 습격이 있었지만 아무도 죽지 않았습니다.';
      continue;
    }
    kill(t, HOW[at.kind], at.by, at.kind);
  }

  for (const t of poisoned) if (t.alive) priv(t, '💊 치료를 받아 독이 사라졌습니다. 살아났어요!');
  // 목격자: 지목한 사람이 공격받았는지, 공격자 후보 3명
  for (const { p, t } of witnesses) {
    const by = attacked[t.id];
    if (!by) { priv(p, `👁 ${t.name}님은 지난밤 공격받지 않았습니다.`); continue; }
    const pool = room.players.filter((x) => x !== t && x !== p && x !== by && (x.alive || nightDeadIds.has(x.id)));
    const list = U.shuffle([by, ...U.shuffle(pool).slice(0, 2)]);
    priv(p, `👁 ${t.name}님이 지난밤 공격받았습니다! 공격자 후보: ${U.names(list)} (이 중 한 명이 진짜예요)`);
  }
  // 유언집행자: 지목한 사람이 밤에 죽었다면 직업을 알고, 아침에 잠깐 대화할 수 있다
  for (const { p, t } of executors) {
    if (!p.alive || t.alive || !nightDeadIds.has(t.id)) continue;
    priv(p, `📜 ${t.name}님이 지난밤 죽었습니다. 직업은 "${U.roleName(t.role)}"이었어요. 아침에 잠시 단둘이 대화할 수 있어요.`);
    room.wills.push({ a: p.id, b: t.id });
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
    // 부활하면 능력을 잃는다: 시민 팀은 시민, 마피아 팀은 악인이 된다 (중립은 그대로, 일반 시민·마피아도 그대로)
    const tm = ROLE[r.t.role].team;
    const to = tm === 'citizen' && r.t.role !== 'citizen' ? 'citizen' : tm === 'mafia' && r.t.role !== 'mafia' && r.t.role !== 'evil' ? 'evil' : null;
    if (to) {
      const old = U.roleName(r.t.role);
      r.t.role = to; r.t.s = {};
      priv(r.t, `💫 부활하면서 ${old}의 능력을 잃고 ${U.roleName(to)}이(가) 되었습니다.`);
    }
  }
  const imm = U.alive(room).filter((x) => x.s.voteImmune === day);
  if (imm.length) U.sys(room, `🛡 오늘은 ${U.names(imm)}님에게 투표할 수 없습니다.`);

  // ---- 8.5 도박사: 예측한 사람이 이번 밤에 실제로 죽었는지 확인
  let gamblerWin = null;
  for (const g of U.alive(room)) {
    if (g.role !== 'gambler' || !g.s.gamble) continue;
    const t = U.byId(room, g.s.gamble); g.s.gamble = null;
    if (!t) continue;
    const need = room.settings.gamblerHits;
    if (nightDeadIds.has(t.id) && !t.alive) {
      g.s.hits = (g.s.hits || 0) + 1;
      priv(g, `🎰 예측 적중! ${t.name}님이 죽었습니다. (${g.s.hits}/${need})`);
      if (g.s.hits >= need && !gamblerWin) gamblerWin = { kind: 'solo', ids: [g.id], text: `🎰 도박사 ${g.name}님이 ${need}번 적중시켜 혼자 우승했습니다!` };
    } else priv(g, `🎰 빗나갔습니다. ${t.name}님은 죽지 않았어요. (${g.s.hits || 0}/${need})`);
  }

  // ---- 9. 지원자: 자신에게 능력을 쓴 사람의 직업 얻기
  for (const v of U.alive(room)) {
    if (v.role !== 'volunteer' || !v.s.volPick) continue;
    const t = U.byId(room, v.s.volPick); v.s.volPick = null;
    if (!t) continue;
    const touched = room.touches.some((c) => c.from === t.id && c.to === v.id);
    if (touched && ROLE[t.role].team === 'citizen' && t.role !== 'volunteer' && t.role !== 'couple') copyRoleNote(room, v, t.role);
  }

  // 도둑: 훔친 능력을 썼으면 되돌리고 다시 훔칠 수 있게 한다
  for (const sw of swapped) {
    const p = sw.p, ls = p.s;
    p.role = sw.role; p.s = sw.s; p.loaning = false;
    if (ls && ls.known) p.s.known = Object.assign(p.s.known || {}, ls.known);
    if (ls && ls.report) p.s.report = ls.report;
    p.s.loan = null; p.s.lnS = null;
    priv(p, '🧤 훔친 능력을 사용했습니다. 이제 다시 다른 사람의 능력을 훔칠 수 있어요.');
  }

  // ---- 10. 아침 공지
  U.sys(room, `☀️ ${day}일차 아침이 밝았습니다.`);
  if (mafiaFailMsg) U.sys(room, mafiaFailMsg);
  for (const d of deaths) U.io.kill(room, d.p, d.how);
  for (const gn of guardNotes) {
    U.sys(room, `🛡 경호원 ${gn.g.name}님이 ${gn.victim.name}님 대신 공격을 받았습니다! 공격한 사람은 ${gn.by.name}님입니다.`);
    priv(gn.g, `🛡 지키던 ${gn.victim.name}님 대신 공격을 받았습니다. (공격한 ${gn.by.name}님이 모두에게 공개되었습니다)`);
  }
  for (const t of revived) U.sys(room, `✨ ${t.name}님이 부활했습니다!`);
  if (!deaths.length && !mafiaFailMsg && !revived.length) U.sys(room, '고요한 밤이었습니다. 아무 일도 일어나지 않았습니다.');

  // 도굴꾼 (1일차 아침)
  if (day === 1) {
    for (const g of U.alive(room)) {
      if (g.role !== 'gravedigger') continue;
      const src = deaths.map((d) => d.p).find((p) => p !== g && !p.alive);
      let role = src ? src.role : 'citizen';
      if (['couple', 'beggar', 'rich', 'gravedigger', 'joker', 'follower', 'prophet'].includes(role)) role = 'citizen';
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
    if ((p.role === 'reporter' || p.role === 'thief' || p.role === 'agitator') && p.s.report && p.s.report.day === day) {
      if (p.alive) {
        const t = U.byId(room, p.s.report.target);
        U.sys(room, `📰 속보! ${t.name}님의 직업은 "${U.roleName(p.s.report.fake || U.shownRole(t))}"입니다.`);
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
  if (gamblerWin && !room.pendingWin) room.pendingWin = gamblerWin;
  if (!room.pendingWin) { // 행운아: 매일 밤 D50
    for (const lk of U.alive(room)) {
      if (lk.role !== 'lucky') continue;
      if (!lk.s.luckyNum) lk.s.luckyNum = 1 + Math.floor(Math.random() * 50);
      const roll = 1 + Math.floor(Math.random() * 50);
      priv(lk, `🎲 오늘 밤 주사위: ${roll} (내 번호: ${lk.s.luckyNum})${roll === lk.s.luckyNum ? ' — 적중!' : ''}`);
      if (roll === lk.s.luckyNum && !room.pendingWin) room.pendingWin = { kind: 'solo', ids: [lk.id], text: `🎰 행운아 ${lk.name}님의 주사위가 ${roll}을 맞춰 혼자 우승했습니다!` };
    }
  }
  if (!room.pendingWin) { // 내기꾼: 필요한 인원에게 가위바위보로 이겼고 아직 살아있다면 우승
    const need = U.bettorNeed(room);
    const bw = U.alive(room).find((x) => x.role === 'bettor' && (x.s.beaten || []).length >= need);
    if (bw) room.pendingWin = { kind: 'solo', ids: [bw.id], text: `✊ 내기꾼 ${bw.name}님이 ${need}명에게 가위바위보로 이겨 혼자 우승했습니다!` };
  }
  room.night = null;
}

module.exports = { startNight, resolveNight, checkAssassins };
