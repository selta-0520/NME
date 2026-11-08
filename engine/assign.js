'use strict';
// 직업 배정
const { ROLES } = require('../roles');
const U = require('./util');

// 팀별로 "묶음" 목록을 만든다. 커플(2명), 거지+부자(2명)는 한 묶음.
function unitsFor(team, enabled) {
  const out = [];
  for (const r of ROLES) {
    if (r.team !== team || r.fixed || !enabled.has(r.key)) continue;
    if (r.key === 'couple') out.push(['couple', 'couple']);
    else if (r.key === 'beggar' || r.key === 'rich') {
      if (r.key === 'beggar' && enabled.has('rich')) out.push(['beggar', 'rich']);
    } else out.push([r.key]);
  }
  return U.shuffle(out);
}
function takeUnits(units, cap, left) {
  const roles = [];
  for (const u of units) {
    if (roles.length + u.length <= cap) roles.push(...u);
    else if (left) left.push(...u);
  }
  return roles;
}
// 필수 지정된 묶음과 아닌 묶음으로 나눈다
function splitForced(units, forced) {
  return { fu: units.filter((u) => u.some((k) => forced.has(k))), ou: units.filter((u) => !u.some((k) => forced.has(k))) };
}

function assignRoles(room) {
  const s = room.settings;
  const enabled = new Set(s.enabledRoles);
  const n = room.players.length;

  const forced = new Set(s.forcedRoles || []);
  const skipped = [];
  const mafiaCount = Math.max(1, Math.floor(n / 4));

  // 중립: 필수 직업은 팀 최대 인원을 넘어도 넣고(시민이 1명은 남도록), 나머지는 최대 인원 안에서 채운다
  const neutralHard = Math.max(0, n - mafiaCount - 1);
  const nu = splitForced(unitsFor('neutral', enabled), forced);
  const nForced = takeUnits(nu.fu, neutralHard, skipped);
  const neutralCap = Math.max(0, Math.min(s.neutralMax, Math.floor(n / 5), neutralHard));
  const neutralRoles = [...nForced, ...takeUnits(nu.ou, Math.max(0, Math.min(neutralCap, neutralHard) - nForced.length))];
  const citizenCount = n - mafiaCount - neutralRoles.length;

  const mu = splitForced(unitsFor('mafia', enabled), forced);
  const mPhys = mafiaCount - 1; // 일반 마피아 최소 1명
  const mForced = takeUnits(mu.fu, mPhys, skipped);
  const mafiaSpecial = [...mForced, ...takeUnits(mu.ou, Math.max(0, Math.min(s.mafiaSpecialMax, mPhys) - mForced.length))];

  const cu = splitForced(unitsFor('citizen', enabled), forced);
  const cForced = takeUnits(cu.fu, citizenCount, skipped);
  const citizenSpecial = [...cForced, ...takeUnits(cu.ou, Math.max(0, Math.min(s.citizenSpecialMax, citizenCount) - cForced.length))];

  const roles = U.shuffle([
    ...mafiaSpecial, ...Array(mafiaCount - mafiaSpecial.length).fill('mafia'),
    ...citizenSpecial, ...Array(citizenCount - citizenSpecial.length).fill('citizen'),
    ...neutralRoles,
  ]);
  U.shuffle(room.players).forEach((p, i) => {
    p.role = roles[i]; p.alive = true; p.s = {}; p.team = null; p.destroyed = false; p.exorcised = false;
    p.contacted = p.role === 'mafia';
  });
  room.touches = []; room.voteActs = {}; room.pendingWin = null;
  return [...new Set(skipped)];
}

module.exports = { assignRoles };
