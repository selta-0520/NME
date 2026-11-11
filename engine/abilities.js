'use strict';
// 직업별 "지금 쓸 수 있는 능력", 채팅 권한, 정보 공개 범위
const { ROLE } = require('../roles');
const U = require('./util');

const ids = (l) => l.map((x) => x.id);

// ------------------------------------------------------------ 밤 능력
// 반환: { label, targets:[id], modes?, mode?, text?, pick, textValue } 또는 null(쓸 능력 없음)
function nightOptions(room, p, modeOverride) {
  if (!p.alive || room.phase !== 'night' || !room.night) return null;
  if (p.s.blockNight === room.day) return null; // 유혹당함
  const A = U.alive(room);
  const others = A.filter((x) => x.id !== p.id);
  const dead = room.players.filter((x) => !x.alive);
  const a = room.night.acts[p.id] || {};
  const o = (label, list, extra) => Object.assign({ label, targets: ids(list), pick: a.target || null, textValue: a.text || '' }, extra || {});

  switch (p.role) {
    case 'mafia':
      return o('🔪 공격할 사람', others.filter((x) => !U.inMafiaChat(x)));
    case 'doppelganger':
      if (U.canAttackAsMafia(room, p)) return o('🔪 공격할 사람', others.filter((x) => !U.inMafiaChat(x)));
      return o('🎭 흉내 낼 사람', others);
    case 'spy': return o('🕵 직업을 조사할 사람', others);
    case 'police': return o('🔍 마피아인지 조사할 사람', others);
    case 'doctor': return o('💉 살릴 사람', A.filter((x) => x.id !== p.id || p.s.lastSelfHeal !== room.day - 1));
    case 'reporter': return p.s.reportUsed ? null : o('📰 속보를 낼 사람 (1회)', others);
    case 'thug': return o('👊 협박할 사람', others);
    case 'medium': return o('🔮 성불시킬 사람', dead.filter((x) => !x.exorcised));
    case 'terrorist': return o('💣 자신을 죽일 것 같은 사람', others);
    case 'priest': return p.s.priestUsed ? null : o('⛪ 부활시킬 사람 (1회)', dead.filter((x) => !x.destroyed));
    case 'volunteer': return o('🙋 지원할 사람', others);
    case 'programmer': return o('💻 익명 메시지를 보낼 사람', others, { text: true });
    case 'ninja': return o('🥷 상호작용을 바꿀 사람', others);
    case 'detective': return o('🕵 비교할 첫 번째 사람 (밤)', A);
    case 'bodyguard': return o('🛡 지킬 사람', others);
    case 'destroyer': {
      const left = U.destroyLimit(room) - (p.s.destroyUsed || 0);
      return left > 0 ? o(`💥 파괴할 사람 (남은 횟수 ${left}번)`, others) : null;
    }
    case 'gambler': return o('🎰 오늘 밤 죽을 것 같은 사람', others);
    case 'thief': {
      if (p.s.loan && !p.loaning) {
        const opt = U.withLoan(p, () => nightOptions(room, p, modeOverride));
        if (opt) opt.label = `🧤 훔친 능력(${ROLE[p.s.loan].name}, 1회) — ${opt.label}`;
        return opt;
      }
      return o('🧤 능력을 훔칠 사람 (한 번 고른 사람은 다시 못 골라요)', others.filter((x) => !(p.s.stolenIds || []).includes(x.id)));
    }
    case 'rich': return o('💰 거지인지 확인할 사람', others);
    case 'ghost': return o('👻 겁줄 사람', others.filter((x) => !(p.s.lastScare && p.s.lastScare.day === room.day - 1 && p.s.lastScare.id === x.id)));
    case 'assassin': return p.contacted ? o('🗡 죽일 사람 (상대의 능력을 무시)', others.filter((x) => !U.inMafiaChat(x))) : null;
    case 'scientist': {
      if (p.s.potionUsed) return null; // 물약은 하나만, 한 번만
      const modes = [{ key: 'heal', label: '살리는 물약' }, { key: 'kill', label: '죽이는 물약' }];
      let mode = modeOverride || a.mode; if (!modes.some((m) => m.key === mode)) mode = modes[0].key;
      return o('⚗ 물약을 쓸 사람 (1회, 둘 중 하나만)', mode === 'heal' ? A : others, { modes, mode });
    }
    case 'madman': {
      const modes = [{ key: 'on', label: '🎲 능력 사용 (랜덤으로 아무나 죽인다, 나도 포함!)' }, { key: 'off', label: '사용 안 함' }];
      const mode = (modeOverride || a.mode) === 'on' ? 'on' : 'off';
      return o('🎲 오늘 밤 능력을 쓸까요?', [], { modes, mode, noTarget: true });
    }
    case 'angel': return p.s.angelUsed ? null : o('✨ 성스러운 가호를 내릴 사람 (1회, 자신 포함)', A);
    default: return null;
  }
}

// ------------------------------------------------------------ 투표시간 능력
function voteOptions(room, p) {
  if (!p.alive || room.phase !== 'vote') return null;
  const A = U.alive(room);
  const others = A.filter((x) => x.id !== p.id);
  const pick = (room.voteActs[p.id] || {}).target || null;
  const o = (label, list) => ({ label, targets: ids(list), pick });
  switch (p.role) {
    case 'detective': return p.s.detA ? o('🕵 비교할 두 번째 사람 (투표시간)', A) : null;
    case 'informant': return o('📢 밀고할 사람 (마피아인지 확인)', others);
    default: return null;
  }
}

// 처형된 테러리스트가 함께 죽을 사람을 고르는 시간
function boomOptions(room, p) {
  if (room.phase !== 'last' || room.lastBoom !== p.id) return null;
  const others = U.alive(room).filter((x) => x.id !== p.id);
  return { label: '💣 함께 죽을 사람을 고르세요', targets: ids(others), pick: room.lastPick || null };
}

// ------------------------------------------------------------ 투표 권한
function canVote(room, p) {
  if (!p.alive) return false;
  if (p.s.noVoteDay === room.day) return false;
  if (p.role === 'fugitive' && p.s.escaped) return false;
  if (p.role === 'beggar' && !p.s.met) return false;
  return true;
}
function voteBlockReason(room, p) {
  if (p.s.noVoteDay === room.day) return '오늘은 투표할 수 없어요.';
  if (p.role === 'fugitive' && p.s.escaped) return '도망친 뒤에는 투표할 수 없어요.';
  if (p.role === 'beggar' && !p.s.met) return '거지는 투표할 수 없어요.';
  return null;
}

// ------------------------------------------------------------ 채팅
// 반환: { ch: 'all'|'mafia'|'couple'|'dead'|null, label }
function chatInfo(room, p) {
  if (room.phase === 'lobby' || room.phase === 'ended') return { ch: 'all', label: '전체 대화' };
  if (!p.alive) {
    if (p.exorcised) return { ch: null, label: '🕊 성불되어 말할 수 없어요' };
    return { ch: 'dead', label: '👻 죽은 사람끼리 보이는 대화' };
  }
  if (p.role === 'beggar' && !p.s.met) return { ch: null, label: '🙏 거지는 말할 수 없어요' };
  if (room.phase === 'night') {
    if (U.inMafiaChat(p)) return { ch: 'mafia', label: '🔪 마피아 팀 비밀 대화' };
    if (p.role === 'couple' && room.players.some((x) => x !== p && x.alive && x.role === 'couple')) return { ch: 'couple', label: '💕 커플 비밀 대화' };
    if (p.role === 'medium') return { ch: 'dead', label: '🔮 죽은 사람과 대화 (밤)' };
    return { ch: null, label: '🌙 밤에는 말할 수 없어요' };
  }
  if (p.s.silenceDay === room.day) return { ch: null, label: '😨 겁을 먹어 말할 수 없어요' };
  return { ch: 'all', label: '전체 대화' };
}

// 이 메시지를 이 사람이 볼 수 있는가
function canSeeMsg(room, p, m) {
  switch (m.ch) {
    case 'all': case 'sys': return true;
    case 'priv': return m.to === p.id;
    case 'mafia': return room.phase === 'ended' || U.inMafiaChat(p);
    case 'couple': return room.phase === 'ended' || p.role === 'couple';
    case 'dead': return room.phase === 'ended' || !p.alive || (p.alive && p.role === 'medium' && !!m.night);
    default: return false;
  }
}

// ------------------------------------------------------------ 정보 공개
function knowsRole(room, v, q) {
  if (!q.role) return false;
  if (v === q || room.phase === 'ended') return true;
  if (!q.alive && room.settings.revealOnDeath) return true;
  if (U.inMafiaChat(v) && U.inMafiaChat(q)) return true;
  if (v.role === 'informant' && v.contacted && U.inMafiaChat(q)) return true;
  if (q.role === 'informant' && q.contacted && U.inMafiaChat(v)) return true;
  if (v.role === 'couple' && q.role === 'couple') return true;
  if (v.role === 'beggar') return true;
  if (v.s.known && v.s.known[q.id]) return true;
  return false;
}
function shownRoleTo(v, q) {
  // 보여 줄 직업 (조사로 알아낸 경우 알아낸 값)
  if (v.s.known && v.s.known[q.id] && v !== q) return v.s.known[q.id];
  return q.role;
}

// 내 직업 카드 아래에 보여 줄 상태 줄들
function infoLines(room, p) {
  const L = [];
  const day = room.day;
  const other = (role) => room.players.find((x) => x !== p && x.role === role);
  if (p.alive && room.phase === 'night' && p.s.blockNight === day) L.push('💋 유혹당해서 오늘 밤에는 능력을 쓸 수 없어요.');
  if (p.alive && p.s.noVoteDay === day && room.phase !== 'night') L.push('🚫 오늘은 투표할 수 없어요.');
  if (p.alive && p.s.silenceDay === day && room.phase !== 'night') L.push('😨 오늘은 말할 수 없어요.');
  switch (p.role) {
    case 'assassin':
      if (!p.contacted && p.s.target && room.day >= 2) { const t = U.byId(room, p.s.target); if (t) L.push(`🎯 오늘의 타겟: ${t.name}${t.alive ? '' : ' (사망 → 접선!)'}`); }
      else if (!p.contacted) L.push('🎯 2일차 밤부터 타겟이 정해져요. 타겟이 죽으면 접선해요.');
      else L.push('🤝 마피아와 접선했어요. 밤마다 1명을 능력 무시하고 죽일 수 있어요.');
      break;
    case 'ghost': if (p.s.lastScare && p.s.lastScare.day === day - 1) { const t = U.byId(room, p.s.lastScare.id); if (t) L.push(`👻 어젯밤 겁준 ${t.name}님은 오늘 밤 고를 수 없어요.`); } break;
    case 'scientist': L.push(p.s.potionUsed ? `⚗ ${p.s.potionUsed === 'heal' ? '살리는' : '죽이는'} 물약을 사용했어요. (더 쓸 수 없어요)` : '⚗ 물약을 1번 쓸 수 있어요. (살리기 또는 죽이기 중 하나)'); break;
    case 'reporter': L.push(p.s.reportUsed ? '📰 속보 사용 완료' : '📰 속보를 1번 낼 수 있어요.'); break;
    case 'priest': L.push(p.s.priestUsed ? '⛪ 부활 사용 완료' : '⛪ 부활을 1번 쓸 수 있어요.'); break;
    case 'angel': {
      if (!p.s.angelUsed) { L.push('✨ 성스러운 가호를 1번 내릴 수 있어요.'); break; }
      const t = p.s.blessT ? U.byId(room, p.s.blessT) : null;
      L.push(t ? `✨ 가호를 내린 사람: ${t.name} ${t.blessed ? '(가호 아직 남음)' : '(가호가 이미 발동했어요)'}` : '✨ 가호 사용 완료'); break;
    }
    case 'destroyer': { const lim = U.destroyLimit(room), used = p.s.destroyUsed || 0; L.push(`💥 파괴 ${used}/${lim}번 사용${used >= lim ? ' (더는 파괴할 수 없어요)' : ''}`); break; }
    case 'gambler': L.push(`🎰 적중 ${p.s.hits || 0}/${room.settings.gamblerHits}번 — 매일 밤 죽을 사람을 예측하세요.`); break;
    case 'follower': { const m = p.s.master ? U.byId(room, p.s.master) : null; L.push(m ? `🙇 주인: ${m.name}${m.alive ? '' : ' (사망 — 이제 우승할 수 없어요)'}` : '🙇 주인이 없어요.'); break; }
    case 'survivor': L.push(`🍀 남은 목숨 ${Math.max(0, 2 - (p.s.surv || 0))}번 — 마피아 팀 또는 시민 팀이 전멸할 때 살아있으면 우승!`); break;
    case 'thief': {
      if (p.s.loan) L.push(`🧤 훔친 능력: ${ROLE[p.s.loan].name} (다음 밤에 딱 1번 쓸 수 있어요)`);
      else L.push('🧤 밤에 1명의 능력을 훔치세요. 마피아 팀 또는 시민 팀이 전멸할 때 살아있으면 우승!');
      const ids = (p.s.stolenIds || []).map((i) => U.byId(room, i)).filter(Boolean);
      if (ids.length) L.push(`🧤 이미 고른 사람: ${U.names(ids)}`);
      break;
    }
    case 'soldier': L.push(p.s.shieldUsed ? '🛡 방어는 이미 사용했어요.' : '🛡 마피아의 공격을 1번 버텨요.'); break;
    case 'fugitive': L.push(p.s.escaped ? '🏃 도망쳤어요. 이제 투표할 수 없어요.' : '🏃 처형을 1번 피할 수 있어요.'); break;
    case 'madman': L.push(p.s.shieldUsed ? '🌀 처형 방어 사용 완료' : '🌀 처형 투표를 1번 견뎌요.'); break;
    case 'bodyguard': L.push('🛡 지킨 사람이 공격으로 죽으면 모두에게 공격한 사람이 알려져요.'); break;
    case 'doctor': if (p.s.lastSelfHeal === day - 1 && room.phase === 'night') L.push('💉 어젯밤 자신을 치료해서 오늘은 자신을 고를 수 없어요.'); break;
    case 'couple': { const m = other('couple'); if (m) L.push(`💕 커플: ${m.name}${m.alive ? '' : ' (사망)'}`); break; }
    case 'beggar': L.push(p.s.met ? '🎉 부자를 만났어요! 12~17초마다 채팅해야 해요. (안 하면 "한푼 줍쇼"가 자동 전송) 2일 뒤 둘 다 살아있으면 우승!' : '🙏 모든 직업을 알지만 말하거나 투표할 수 없어요.'); break;
    case 'rich': L.push(p.s.meetDay != null ? '🎉 거지를 만났어요! 둘 다 살아있으면 곧 우승해요.' : '💰 거지를 찾아 보세요.'); break;
    case 'revolutionary': L.push(p.s.joined ? `✊ ${p.team === 'mafia' ? '마피아' : '시민'} 팀이 되었어요.` : '✊ 4일차 낮까지 아무도 나에게 능력을 쓰지 않으면 우승해요.'); break;
    case 'madam': L.push('💋 투표할 때 선택한 사람이 유혹당해요. (마피아를 고르면 접선)'); break;
    case 'doppelganger': if (p.s.disguise) L.push(`🎭 지금 "${U.roleName(p.s.disguise)}"(으)로 보여요.`); break;
    case 'mafia': case 'spy': case 'ghost': case 'informant': break;
    default: break;
  }
  return L;
}

module.exports = { nightOptions, voteOptions, boomOptions, canVote, voteBlockReason, chatInfo, canSeeMsg, knowsRole, shownRoleTo, infoLines };
