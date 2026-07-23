/**
 * Group Manager
 *
 * Supports two conditions:
 *   control     — 4 participants, all must agree on each triple, majority announce vote
 *   adversarial — 1 left-brain + 1 right-brain pair, same consensus rules as control,
 *                 majority announce vote (both must agree)
 */

const { v4: uuidv4 } = require("uuid");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const GROUP_SIZE             = 4;   // control condition
const ADVERSARIAL_GROUP_SIZE = 2;   // adversarial condition (1 left + 1 right)
const MAX_ROUNDS             = 20;
const DROPOUT_TIMEOUT_MS     = 60000;

// ─── STATE ────────────────────────────────────────────────────────────────────
const waitingParticipants = [];   // control condition
const adversarialWaiting  = [];   // adversarial condition, includes team field
const groups              = {};
const socketToGroup       = {};

// Running pair-type counts for balanced matching
let homogeneousPairsFormed   = 0;
let heterogeneousPairsFormed = 0;

// ─── WAITING ROOM — CONTROL ───────────────────────────────────────────────────

function addToWaiting(socketId, qualtricsRid) {
  if (waitingParticipants.find((p) => p.socketId === socketId)) return;
  waitingParticipants.push({ socketId, qualtricsRid, joinedAt: Date.now() });
}

function removeFromWaiting(socketId) {
  const idx = waitingParticipants.findIndex((p) => p.socketId === socketId);
  if (idx !== -1) waitingParticipants.splice(idx, 1);
}

function getWaitingCount()     { return waitingParticipants.length; }
function getWaitingSocketIds() { return waitingParticipants.map((p) => p.socketId); }

function tryFormGroup() {
  if (waitingParticipants.length < GROUP_SIZE) return null;

  const members = waitingParticipants.splice(0, GROUP_SIZE);
  const groupId = uuidv4();
  const labels  = ["A", "B", "C", "D"].slice(0, GROUP_SIZE);

  const participants = members.map((m, i) => ({
    socketId:      m.socketId,
    participantId: uuidv4(),
    label:         `Participant ${labels[i]}`,
    team:          null,
    qualtricsRid:  m.qualtricsRid,
    joinedAt:      m.joinedAt,
    active:        true,
    lastSeen:      Date.now(),
  }));

  const group = {
    groupId,
    participants,
    round:              0,
    trials:             [],
    chatLog:            [],
    status:             "active",
    ruleAnnouncement:   null,
    createdAt:          Date.now(),
    pendingSubmissions: new Map(),
    announceVotes:      new Set(),
    condition:          "control",
    teams:              null,
  };

  groups[groupId] = group;
  participants.forEach((p) => { socketToGroup[p.socketId] = groupId; });
  return group;
}

// ─── WAITING ROOM — ADVERSARIAL ───────────────────────────────────────────────

function addToAdversarialWaiting(socketId, qualtricsRid, team) {
  if (adversarialWaiting.find((p) => p.socketId === socketId)) return;
  adversarialWaiting.push({ socketId, qualtricsRid, team, joinedAt: Date.now() });
}

function removeFromAdversarialWaiting(socketId) {
  const idx = adversarialWaiting.findIndex((p) => p.socketId === socketId);
  if (idx !== -1) adversarialWaiting.splice(idx, 1);
}

function isInAdversarialWaiting(socketId) {
  return adversarialWaiting.some((p) => p.socketId === socketId);
}

function getAdversarialWaitingCounts() {
  return {
    blue: adversarialWaiting.filter((p) => p.team === "blue").length,
    red:  adversarialWaiting.filter((p) => p.team === "red").length,
  };
}

function getAdversarialWaitingSocketIds() {
  return adversarialWaiting.map((p) => p.socketId);
}

function getAdversarialWaitingTeam(socketId) {
  const entry = adversarialWaiting.find((p) => p.socketId === socketId);
  return entry ? entry.team : null;
}

/**
 * Forms a pair of two adversarial participants.
 * Prioritises the pair type (homogeneous vs heterogeneous) that is currently
 * underrepresented so the dataset stays balanced across session lifetime.
 *
 * Homogeneous  — both symmetrical (blue) or both asymmetrical (red)
 * Heterogeneous — one of each
 */
function tryFormAdversarialGroup() {
  const blues = adversarialWaiting.filter((p) => p.team === "blue");
  const reds  = adversarialWaiting.filter((p) => p.team === "red");

  const canFormHomogeneous   = blues.length >= 2 || reds.length >= 2;
  const canFormHeterogeneous = blues.length >= 1 && reds.length >= 1;

  if (!canFormHomogeneous && !canFormHeterogeneous) return null;

  // Prefer whichever type is currently underrepresented (ties go to homogeneous)
  const preferHomogeneous = homogeneousPairsFormed <= heterogeneousPairsFormed;

  let chosen;
  let pairType;

  if (preferHomogeneous && canFormHomogeneous) {
    // Pick the larger pool to keep wait times short
    if (blues.length >= 2 && (blues.length >= reds.length || reds.length < 2)) {
      chosen = [blues[0], blues[1]];
    } else {
      chosen = [reds[0], reds[1]];
    }
    pairType = "homogeneous";
  } else if (!preferHomogeneous && canFormHeterogeneous) {
    chosen   = [blues[0], reds[0]];
    pairType = "heterogeneous";
  } else if (canFormHeterogeneous) {
    chosen   = [blues[0], reds[0]];
    pairType = "heterogeneous";
  } else {
    // Only homogeneous is possible
    chosen   = blues.length >= 2 ? [blues[0], blues[1]] : [reds[0], reds[1]];
    pairType = "homogeneous";
  }

  chosen.forEach((m) => removeFromAdversarialWaiting(m.socketId));

  if (pairType === "homogeneous") homogeneousPairsFormed++;
  else                            heterogeneousPairsFormed++;

  const groupId = uuidv4();
  const labels  = ["A", "B"];

  const participants = chosen.map((m, i) => ({
    socketId:      m.socketId,
    participantId: uuidv4(),
    label:         `Participant ${labels[i]}`,
    team:          m.team,
    qualtricsRid:  m.qualtricsRid,
    joinedAt:      m.joinedAt,
    active:        true,
    lastSeen:      Date.now(),
  }));

  const group = {
    groupId,
    participants,
    round:              0,
    trials:             [],
    chatLog:            [],
    status:             "active",
    ruleAnnouncement:   null,
    createdAt:          Date.now(),
    pendingSubmissions: new Map(),
    announceVotes:      new Set(),
    condition:          "adversarial",
    pairType,
    teams: {
      blue: chosen.filter((m) => m.team === "blue").map((m) => m.socketId),
      red:  chosen.filter((m) => m.team === "red").map((m) => m.socketId),
    },
  };

  groups[groupId] = group;
  participants.forEach((p) => { socketToGroup[p.socketId] = groupId; });
  return group;
}

function getPairTypeCounts() {
  return { homogeneous: homogeneousPairsFormed, heterogeneous: heterogeneousPairsFormed };
}

// ─── GROUP LOOKUPS ────────────────────────────────────────────────────────────

function getGroupBySocket(socketId) {
  const groupId = socketToGroup[socketId];
  return groupId ? groups[groupId] : null;
}

function getGroup(groupId) { return groups[groupId] || null; }

function getParticipant(group, socketId) {
  return group.participants.find((p) => p.socketId === socketId) || null;
}

function getTeamOfSocket(group, socketId) {
  if (!group.teams) return null;
  if (group.teams.blue.includes(socketId)) return "blue";
  if (group.teams.red.includes(socketId))  return "red";
  return null;
}

// ─── ACTIVE COUNTS ────────────────────────────────────────────────────────────

function getActiveCountsByTeam(group) {
  const total = group.participants.filter((p) => p.active).length;
  const max   = group.participants.length;
  if (group.condition !== "adversarial") {
    return { total, max };
  }
  return {
    blue:     group.participants.filter((p) => p.active && group.teams.blue.includes(p.socketId)).length,
    red:      group.participants.filter((p) => p.active && group.teams.red.includes(p.socketId)).length,
    blueMax:  group.teams.blue.length,
    redMax:   group.teams.red.length,
    total,
    max,
    pairType: group.pairType,
  };
}

// ─── CHAT ─────────────────────────────────────────────────────────────────────

function addChatMessage(group, label, message) {
  const entry = { round: group.round, label, message, timestamp: Date.now() };
  group.chatLog.push(entry);
  return entry;
}

// ─── CONSENSUS SUBMISSIONS ────────────────────────────────────────────────────

function normaliseTriple(a, b, c) {
  const nums = [a, b, c].map(Number);
  if (nums.some((n) => !isFinite(n))) return null;
  return nums;
}

function recordSubmission(group, socketId, nums, rationale) {
  group.pendingSubmissions.set(socketId, { nums, rationale });
  return group.pendingSubmissions.size;
}

function clearSubmission(group, socketId) {
  group.pendingSubmissions.delete(socketId);
}

function clearAllSubmissions(group) {
  group.pendingSubmissions.clear();
}

/** All active participants must submit the same triple (both conditions). */
function checkConsensus(group) {
  const active   = group.participants.filter((p) => p.active);
  const needed   = active.length;
  const submitted = active.filter((p) => group.pendingSubmissions.has(p.socketId)).length;

  if (submitted < needed) {
    return { status: "waiting", submitted, needed };
  }

  const allNums   = active.map((p) => group.pendingSubmissions.get(p.socketId).nums);
  const reference = allNums[0];
  const allMatch  = allNums.every(
    (n) => n[0] === reference[0] && n[1] === reference[1] && n[2] === reference[2]
  );

  if (!allMatch) {
    return { status: "mismatch", submitted, needed, triples: allNums };
  }

  const rationales = {};
  for (const p of active) {
    const sub = group.pendingSubmissions.get(p.socketId);
    if (sub) rationales[p.label] = sub.rationale;
  }

  return { status: "consensus", nums: reference, rationales };
}

// ─── TRIALS ───────────────────────────────────────────────────────────────────

function recordTrial(group, triple, rationales, evaluationResult) {
  group.round += 1;
  const entry = {
    round:     group.round,
    triple,
    rationales,
    verdict:   evaluationResult.verdict,
    conforms:  evaluationResult.conforms,
    nums:      evaluationResult.nums,
    timestamp: Date.now(),
  };
  group.trials.push(entry);
  clearAllSubmissions(group);
  return entry;
}

function isAtRoundCap(group) { return group.round >= MAX_ROUNDS; }

// ─── ANNOUNCE VOTING ──────────────────────────────────────────────────────────

function toggleAnnounceVote(group, socketId) {
  if (group.announceVotes.has(socketId)) {
    group.announceVotes.delete(socketId);
    return false;
  }
  group.announceVotes.add(socketId);
  return true;
}

function clearAnnounceVotes(group)      { group.announceVotes.clear(); }
function getAnnounceVoteCount(group)    { return group.announceVotes.size; }

function getReadyLabels(group) {
  return Array.from(group.announceVotes)
    .map((sid) => group.participants.find((p) => p.socketId === sid))
    .filter(Boolean)
    .map((p) => p.label);
}

function pickRandomActive(group) {
  const active = group.participants.filter((p) => p.active);
  return active[Math.floor(Math.random() * active.length)];
}

/** Strictly more than half of active participants. */
function announceThreshold(group) {
  const active = group.participants.filter((p) => p.active).length;
  return Math.floor(active / 2) + 1;
}

// ─── RULE ANNOUNCEMENT ────────────────────────────────────────────────────────

function recordAnnouncement(group, statedRule, assessment) {
  group.status = "announced";
  group.ruleAnnouncement = {
    statedRule,
    assessment,
    round:     group.round,
    timestamp: Date.now(),
  };
}

function markComplete(group) {
  group.status      = "complete";
  group.completedAt = Date.now();
}

// ─── DROPOUT HANDLING ─────────────────────────────────────────────────────────

function markDisconnected(socketId) {
  const group = getGroupBySocket(socketId);
  if (!group) return null;

  const participant = getParticipant(group, socketId);
  if (participant) {
    participant.active         = false;
    participant.disconnectedAt = Date.now();
  }

  delete socketToGroup[socketId];
  return group;
}

function activeParticipantCount(group) {
  return group.participants.filter((p) => p.active).length;
}

// ─── SESSION EXPORT ───────────────────────────────────────────────────────────

function exportSession(group) {
  return {
    groupId:          group.groupId,
    createdAt:        group.createdAt,
    completedAt:      group.completedAt || null,
    status:           group.status,
    condition:        group.condition,
    pairType:         group.pairType || null,
    groupSize:        group.participants.length,
    participants:     group.participants.map((p) => ({
      label:         p.label,
      team:          p.team,
      qualtricsRid:  p.qualtricsRid,
      participantId: p.participantId,
      active:        p.active,
    })),
    totalTrials:      group.trials.length,
    trials:           group.trials,
    ruleAnnouncement: group.ruleAnnouncement || null,
    chatLog:          group.chatLog,
  };
}

// ─── SUMMARY PARAMS ───────────────────────────────────────────────────────────

function summaryParams(group, participantLabel) {
  const correct = group.ruleAnnouncement && !group.ruleAnnouncement.assessment.flagged;
  return new URLSearchParams({
    task_complete:     "1",
    participant_label: participantLabel,
    total_trials:      group.trials.length,
    rule_stated:       group.ruleAnnouncement
      ? encodeURIComponent(group.ruleAnnouncement.statedRule)
      : "",
    rule_correct_flag: correct ? "1" : "0",
    group_id:          group.groupId,
    condition:         group.condition,
  }).toString();
}

module.exports = {
  // Control waiting
  addToWaiting,
  removeFromWaiting,
  getWaitingCount,
  getWaitingSocketIds,
  tryFormGroup,
  // Adversarial waiting
  addToAdversarialWaiting,
  removeFromAdversarialWaiting,
  isInAdversarialWaiting,
  getAdversarialWaitingCounts,
  getAdversarialWaitingSocketIds,
  getAdversarialWaitingTeam,
  tryFormAdversarialGroup,
  getPairTypeCounts,
  // Group lookups
  getGroupBySocket,
  getGroup,
  getParticipant,
  getTeamOfSocket,
  getActiveCountsByTeam,
  // Chat
  addChatMessage,
  // Submissions
  normaliseTriple,
  recordSubmission,
  clearSubmission,
  clearAllSubmissions,
  checkConsensus,
  // Trials
  recordTrial,
  isAtRoundCap,
  // Announce voting
  toggleAnnounceVote,
  clearAnnounceVotes,
  getAnnounceVoteCount,
  getReadyLabels,
  pickRandomActive,
  announceThreshold,
  // Completion
  recordAnnouncement,
  markComplete,
  // Dropout
  markDisconnected,
  activeParticipantCount,
  // Export
  exportSession,
  summaryParams,
  // Constants
  GROUP_SIZE,
  ADVERSARIAL_GROUP_SIZE,
  MAX_ROUNDS,
};
