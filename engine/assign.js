'use strict';
// 직업 배정
//  - 직업마다 "최소~최대 인원"을 정할 수 있다. (⭐ 필수 = 최소 1명 이상)
//  - 마피아·시민도 다른 직업처럼 넣기/빼기가 가능하다.
//  - 마피아 팀 인원 = 방장이 정한 인원(0이면 참가 인원 ÷ 4, 최소 1명). 중립 팀은 팀 최대 인원까지 채운다.
const { ROLES, roleCap } = require('../roles');
const U = require('./util');

const SIZE = (k) => (k === 'couple' || k === 'beggar' || k === 'prosecutor' ? 2 : 1); // 커플·(거지+부자)·(검사+변호사)는 2명이 한 묶음

function assignRoles(room) {
  const s = room.settings;
  const n = room.players.length;
  const enabled = new Set(s.enabledRoles);
  const forcedSet = new Set(s.forcedRoles || []); // ⭐ 필수 = 최소 1명
  if (!enabled.has('beggar') || !enabled.has('rich')) { enabled.delete('beggar'); enabled.delete('rich'); }
  if (!enabled.has('prosecutor') || !enabled.has('lawyer')) { enabled.delete('prosecutor'); enabled.delete('lawyer'); }
  const skipped = [], notes = [];
  if (!s.finalDefense && enabled.has('prosecutor')) { enabled.delete('prosecutor'); enabled.delete('lawyer'); notes.push('ℹ️ 최후의 반론이 꺼져 있어 검사·변호사는 나오지 않아요.'); }

  // 직업별 [최소, 최대] (묶음 개수 기준)
  const rng = (key) => {
    if (!enabled.has(key)) return [0, 0];
    const cap = roleCap(key);
    let mn = Math.min(cap, Math.max(0, (s.roleMin && s.roleMin[key]) | 0));
    const mxRaw = s.roleMax && s.roleMax[key] != null ? s.roleMax[key] | 0 : (key === 'mafia' || key === 'citizen' ? cap : 1);
    const mx = Math.min(cap, Math.max(mn, mxRaw));
    if (forcedSet.has(key) && mx > 0) mn = Math.max(mn, 1);
    if (key === 'mafia' && mx > 0) mn = Math.max(mn, 1); // 마피아를 켜 두었다면 일반 마피아는 항상 1명 이상 (공격할 사람이 있어야 하니까)
    return [mn, mx];
  };
  const keysOf = (team) => ROLES.filter((r) => r.team === team && r.key !== 'rich' && r.key !== 'lawyer' && rng(r.key)[1] > 0).map((r) => r.key);
  const counts = {};
  const cnt = (k) => counts[k] || 0;
  const add = (k) => { counts[k] = cnt(k) + 1; };

  // 한 팀을 채운다. slots: 이 팀에 줄 수 있는 자리, plainKey: 일반 직업(마피아/시민), specialCap: 특수 직업 팀 최대 인원
  // 반환: 실제로 채운 인원수
  const fillTeam = (team, slots, plainKey, specialCap) => {
    const keys = keysOf(team);
    const specials = keys.filter((k) => k !== plainKey);
    const plainHi = rng(plainKey)[1];
    const specialCount = () => specials.reduce((a, k) => a + cnt(k) * SIZE(k), 0);
    const used = () => specialCount() + cnt(plainKey);
    const addRandomSpecial = (maxSize) => {
      const c = specials.filter((k) => cnt(k) < rng(k)[1] && SIZE(k) <= maxSize);
      if (!c.length) return false;
      add(U.pick(c)); return true;
    };
    // 1) 최소 인원(필수)부터 넣는다. 자리가 모자라면 못 넣는다.
    for (const k of [plainKey, ...U.shuffle(specials)]) {
      if (!keys.includes(k)) continue;
      for (let i = 0; i < rng(k)[0]; i++) {
        if (used() + SIZE(k) <= slots) add(k); else if (!skipped.includes(k)) skipped.push(k);
      }
    }
    if (plainHi > 0) {
      // 2) 특수 직업을 팀 최대 인원까지 (일반 직업이 한 명도 없으면 1자리는 남겨 둔다)
      const reserve = () => (cnt(plainKey) > 0 ? 0 : 1);
      while (specialCount() < specialCap && addRandomSpecial(slots - used() - reserve())) { /* 계속 */ }
      // 3) 일반 직업 최대 인원을 넘는 자리는 특수 직업이 메운다
      while (slots - specialCount() > plainHi && addRandomSpecial(slots - used())) { /* 계속 */ }
      counts[plainKey] = Math.max(cnt(plainKey), Math.min(plainHi, slots - specialCount()));
    } else {
      // 일반 직업을 끈 경우: 특수 직업만으로 채운다 (팀 최대 인원 제한 없음)
      while (used() < slots && addRandomSpecial(slots - used())) { /* 계속 */ }
    }
    return used();
  };

  // ---------------- 마피아 팀
  const mafiaKeys = keysOf('mafia');
  const sizeSet = Math.max(0, s.mafiaSize | 0); // 0 = 자동(인원 ÷ 4), 그 외 = 마피아 팀 총 인원
  const nSize = Math.max(0, s.neutralSize | 0), cSize = Math.max(0, s.citizenSize | 0);
  let M = sizeSet > 0 ? sizeSet : Math.max(1, Math.floor(n / 4));
  if (sizeSet === 0 && cSize > 0) M = Math.max(1, n - cSize - nSize); // 마피아는 자동이고 시민 인원을 정했다면 나머지가 마피아
  const minMafia = mafiaKeys.reduce((a, k) => a + rng(k)[0] * SIZE(k), 0);
  const maxM = Math.max(1, Math.ceil(n / 2) - 1); // 시작하자마자 마피아 팀이 이기지 않도록
  if (sizeSet > 0 && minMafia > sizeSet) notes.push(`⚠ 마피아 팀 인원(${sizeSet}명)보다 직업별 최소 인원 합(${minMafia}명)이 커서 최소 인원을 우선했어요.`);
  M = Math.min(Math.max(M, minMafia), maxM);
  const capMafia = mafiaKeys.reduce((a, k) => a + rng(k)[1] * SIZE(k), 0);
  let forcePlainMafia = false;
  if (capMafia === 0) { forcePlainMafia = true; notes.push('⚠ 마피아 팀으로 쓸 직업이 하나도 켜져 있지 않아 일반 마피아를 넣었어요.'); }
  else M = Math.min(M, capMafia);
  let mafiaUsed;
  if (forcePlainMafia) { counts.mafia = M; mafiaUsed = M; }
  else {
    // 인원을 직접 정했다면 일반 마피아 최소 인원을 뺀 나머지 자리는 팀 직업이 채운다. 자동이면 특수 직업은 최대 2명(기본)까지.
    const specialCap = sizeSet > 0 ? M : Math.max(0, s.mafiaSpecialMax == null ? 2 : s.mafiaSpecialMax);
    mafiaUsed = fillTeam('mafia', M, 'mafia', specialCap);
    if (mafiaUsed < 1) { counts.mafia = 1; mafiaUsed = 1; notes.push('⚠ 마피아 팀에 넣을 수 있는 직업이 부족해 일반 마피아 1명을 넣었어요.'); }
  }
  M = mafiaUsed;

  // ---------------- 중립 팀 (필수는 팀 최대 인원을 넘어도 넣는다. 단, 시민이 1명은 남도록)
  const neutralHard = Math.max(0, n - M - 1);
  const neutralKeys = keysOf('neutral');
  let nUsed = 0;
  for (const k of U.shuffle(neutralKeys)) {
    const [mn] = rng(k);
    for (let i = 0; i < mn; i++) {
      if (nUsed + SIZE(k) <= neutralHard) { add(k); nUsed += SIZE(k); } else if (!skipped.includes(k)) skipped.push(k);
    }
  }
  const neutralCap = nSize > 0 ? Math.max(0, Math.min(nSize, neutralHard)) : Math.max(0, Math.min(s.neutralMax == null ? 2 : s.neutralMax, Math.floor(n / 5), neutralHard));
  for (;;) {
    const c = neutralKeys.filter((k) => cnt(k) < rng(k)[1] && nUsed + SIZE(k) <= Math.min(neutralCap, neutralHard));
    if (!c.length) break;
    const k = U.pick(c); add(k); nUsed += SIZE(k);
  }

  // ---------------- 시민 팀
  const citizenCount = n - M - nUsed;
  const citizenSpecialCap = cSize > 0 ? citizenCount : Math.max(0, s.citizenSpecialMax == null ? 12 : s.citizenSpecialMax);
  const cUsed = fillTeam('citizen', citizenCount, 'citizen', citizenSpecialCap);
  if (cSize > 0 && cSize !== citizenCount) notes.push(`⚠ 마피아·중립 인원을 맞추고 나니 시민 팀은 ${citizenCount}명이 되었어요. (설정 ${cSize}명)`);
  if (cUsed < citizenCount) { // 자리가 남으면 일반 시민이 메운다 (시민을 끈 경우 안내)
    counts.citizen = cnt('citizen') + (citizenCount - cUsed);
    if (rng('citizen')[1] === 0) notes.push('⚠ 시민 팀에 넣을 수 있는 직업이 부족해 일반 시민이 들어갔어요.');
  }

  // ---------------- 직업 목록 → 플레이어에게 나눠 주기
  const list = [];
  for (const [k, v] of Object.entries(counts)) {
    for (let i = 0; i < v; i++) {
      if (k === 'couple') list.push('couple', 'couple');
      else if (k === 'beggar') list.push('beggar', 'rich');
      else if (k === 'prosecutor') list.push('prosecutor', 'lawyer');
      else list.push(k);
    }
  }
  while (list.length < n) list.push('citizen');
  const roles = U.shuffle(list).slice(0, n);
  U.shuffle(room.players).forEach((p, i) => {
    p.role = roles[i]; p.alive = true; p.s = {}; p.team = null; p.destroyed = false; p.exorcised = false; p.blessed = false; p.blessedBy = null; p.loaning = false; p.origRole = roles[i]; p.guess = null; p.snap = null;
    p.contacted = p.role === 'mafia';
  });
  room.touches = []; room.voteActs = {}; room.pendingWin = null;
  room.startN = n;
  for (const p of room.players) if (p.role === 'follower') U.assignMaster(room, p, true); // 신봉자의 주인 (알림은 게임 시작 때)
  room.assignNotes = notes;
  return [...new Set(skipped)];
}

module.exports = { assignRoles };
