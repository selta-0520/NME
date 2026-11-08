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
function takeUnits(units, cap) {
  const roles = [];
  for (const u of units) {
    if (roles.length + u.length <= cap) roles.push(...u);
  }
  return roles;
}

function assignRoles(room) {
  const s = room.settings;
  const enabled = new Set(s.enabledRoles);
  const n = room.players.length;

  const mafiaCount = Math.max(1, Math.floor(n / 4));
  const neutralCap = Math.max(0, Math.min(s.neutralMax, Math.floor(n / 5), n - mafiaCount - 1));
  const neutralRoles = takeUnits(unitsFor('neutral', enabled), neutralCap);
  const citizenCount = n - mafiaCount - neutralRoles.length;

  const mafiaSpecial = takeUnits(unitsFor('mafia', enabled), Math.min(s.mafiaSpecialMax, mafiaCount - 1)); // 일반 마피아 최소 1명
  const citizenSpecial = takeUnits(unitsFor('citizen', enabled), Math.min(s.citizenSpecialMax, citizenCount));

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
}

module.exports = { assignRoles };
