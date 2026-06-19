/**
 * Group Manager
 *
 * Handles all group state: waiting room assembly, participant tracking,
 * round state, trial history, chat logs, dropout detection, and
 * per-round consensus submission tracking.
 *
 * State is held in-memory. Adequate for pilot studies with short sessions.
 * Replace with Redis/Postgres for production scale or crash recovery.
 */

const { v4: uuidv4 } = require("uuid");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const GROUP_SIZE = 4;         // participants per group
const MAX_ROUNDS = 20;        // hard cap on trial rounds
const DROPOUT_TIMEOUT_MS = 60000; // ms before absent participant is flagged

// ─── STATE ────────────────────────────────────────────────────────────────────
// waiting: participants not yet assigned to a group
const waitingParticipants = [];

// groups: keyed by groupId
// {
//   groupId, participants: [{socketId, participantId, label, qualtricsRid, joinedAt}],
//   round: number, trials: [...], chatLog: [...],
//   status: 'active'|'announced'|'complete',
//   ruleAnnouncement: string|null, createdAt
// }
const groups = {};

// socketId → groupId index for fast lookup
const socketToGroup = {};

// ─── WAITING ROOM ─────────────────────────────────────────────────────────────

function addToWaiting(socketId, qualtricsRid) {
  // Avoid duplicates (reconnect edge case)
  if (waitingParticipants.find((p) => p.socketId === socketId)) return;
  waitingParticipants.push({ socketId, qualtricsRid, joinedAt: Date.now() });
}

function removeFromWaiting(socketId) {
  const idx = waitingParticipants.findIndex((p) => p.socketId === socketId);
  if (idx !== -1) waitingParticipants.splice(idx, 1);
}

function getWaitingCount() {
  return waitingParticipants.length;
}

/**
 * Attempt to assemble a group from waiting participants.
 * Returns the new group object if successful, null otherwise.
 */
function tryFormGroup() {
  if (waitingParticipants.length < GROUP_SIZE) return null;

  const members = waitingParticipants.splice(0, GROUP_SIZE);
  const groupId = uuidv4();
  const labels = ["A", "B", "C", "D", "E"].slice(0, GROUP_SIZE);

  const participants = members.map((m, i) => ({
    socketId: m.socketId,
    participantId: uuidv4(),
    label: `Participant ${labels[i]}`,
    qualtricsRid: m.qualtricsRid,
    joinedAt: m.joinedAt,
    active: true,
    lastSeen: Date.now(),
  }));

  const group = {
    groupId,
    participants,
    round: 0,
    trials: [],            // { round, triple, rationales, verdict, conforms, timestamp }
    chatLog: [],           // { round, label, message, timestamp }
    status: "active",
    ruleAnnouncement: null,
    createdAt: Date.now(),
    // Per-round consensus tracking.
    // pendingSubmissions: Map<socketId, { nums: [a,b,c], rationale: string }>
    // Cleared after each accepted trial.
    pendingSubmissions: new Map(),
    // socketIds of participants who have clicked "ready to announce"
    announceVotes: new Set(),
  };

  groups[groupId] = group;
  participants.forEach((p) => {
    socketToGroup[p.socketId] = groupId;
  });

  return group;
}

// ─── GROUP LOOKUPS ────────────────────────────────────────────────────────────

function getGroupBySocket(socketId) {
  const groupId = socketToGroup[socketId];
  return groupId ? groups[groupId] : null;
}

function getGroup(groupId) {
  return groups[groupId] || null;
}

function getParticipant(group, socketId) {
  return group.participants.find((p) => p.socketId === socketId) || null;
}

// ─── CHAT ─────────────────────────────────────────────────────────────────────

function addChatMessage(group, label, message) {
  const entry = {
    round: group.round,
    label,
    message,
    timestamp: Date.now(),
  };
  group.chatLog.push(entry);
  return entry;
}

// ─── CONSENSUS SUBMISSIONS ────────────────────────────────────────────────────

/**
 * Normalise a triple to a canonical [a, b, c] number array.
 * Returns null if any value is not a finite number.
 */
function normaliseTriple(a, b, c) {
  const nums = [a, b, c].map(Number);
  if (nums.some((n) => !isFinite(n))) return null;
  return nums;
}

/**
 * Record one participant's submission for the current round.
 * Returns the updated submission count.
 */
function recordSubmission(group, socketId, nums, rationale) {
  group.pendingSubmissions.set(socketId, { nums, rationale });
  return group.pendingSubmissions.size;
}

/**
 * Remove a participant's pending submission (e.g. to allow resubmission).
 */
function clearSubmission(group, socketId) {
  group.pendingSubmissions.delete(socketId);
}

/**
 * Clear all pending submissions for the round (after acceptance or reset).
 */
function clearAllSubmissions(group) {
  group.pendingSubmissions.clear();
}

/**
 * Check the current submission state for the group.
 * Returns one of three outcomes:
 *
 *   { status: 'waiting',  submitted: N, needed: M }
 *     — not everyone has submitted yet
 *
 *   { status: 'mismatch', submitted: N, needed: M, triples: [...] }
 *     — everyone submitted but triples differ
 *
 *   { status: 'consensus', nums: [a,b,c], rationales: Map<label, string> }
 *     — everyone submitted the same triple; ready to evaluate
 */
function checkConsensus(group) {
  const active = group.participants.filter((p) => p.active);
  const needed  = active.length;
  const submitted = group.pendingSubmissions.size;

  if (submitted < needed) {
    return { status: "waiting", submitted, needed };
  }

  // Everyone has submitted — check agreement
  const allNums = Array.from(group.pendingSubmissions.values()).map((s) => s.nums);
  const reference = allNums[0];
  const allMatch = allNums.every(
    (n) => n[0] === reference[0] && n[1] === reference[1] && n[2] === reference[2]
  );

  if (!allMatch) {
    // Build a readable list of what each person submitted (for server log),
    // but we do NOT send individual values to clients — only the mismatch signal.
    return {
      status: "mismatch",
      submitted,
      needed,
      triples: allNums,
    };
  }

  // Build rationale map keyed by participant label
  const rationales = {};
  for (const [socketId, sub] of group.pendingSubmissions.entries()) {
    const participant = active.find((p) => p.socketId === socketId);
    if (participant) rationales[participant.label] = sub.rationale;
  }

  return { status: "consensus", nums: reference, rationales };
}

// ─── TRIALS ───────────────────────────────────────────────────────────────────

function recordTrial(group, triple, rationales, evaluationResult) {
  group.round += 1;
  const entry = {
    round: group.round,
    triple,
    rationales,   // { "Participant A": "...", "Participant B": "..." }
    verdict: evaluationResult.verdict,
    conforms: evaluationResult.conforms,
    nums: evaluationResult.nums,
    timestamp: Date.now(),
  };
  group.trials.push(entry);
  clearAllSubmissions(group);
  return entry;
}

function isAtRoundCap(group) {
  return group.round >= MAX_ROUNDS;
}

// ─── ANNOUNCE VOTING ──────────────────────────────────────────────────────────

function toggleAnnounceVote(group, socketId) {
  if (group.announceVotes.has(socketId)) {
    group.announceVotes.delete(socketId);
    return false;
  }
  group.announceVotes.add(socketId);
  return true;
}

function clearAnnounceVotes(group) {
  group.announceVotes.clear();
}

function getAnnounceVoteCount(group) {
  return group.announceVotes.size;
}

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

// ─── RULE ANNOUNCEMENT ────────────────────────────────────────────────────────

function recordAnnouncement(group, statedRule, assessment) {
  group.status = "announced";
  group.ruleAnnouncement = {
    statedRule,
    assessment,
    round: group.round,
    timestamp: Date.now(),
  };
}

function markComplete(group) {
  group.status = "complete";
  group.completedAt = Date.now();
}

// ─── DROPOUT HANDLING ─────────────────────────────────────────────────────────

function markDisconnected(socketId) {
  const group = getGroupBySocket(socketId);
  if (!group) return null;

  const participant = getParticipant(group, socketId);
  if (participant) {
    participant.active = false;
    participant.disconnectedAt = Date.now();
  }

  delete socketToGroup[socketId];
  return group;
}

function activeParticipantCount(group) {
  return group.participants.filter((p) => p.active).length;
}

// ─── SESSION EXPORT ───────────────────────────────────────────────────────────

/**
 * Produce a complete session record for logging/export.
 */
function exportSession(group) {
  return {
    groupId: group.groupId,
    createdAt: group.createdAt,
    completedAt: group.completedAt || null,
    status: group.status,
    groupSize: group.participants.length,
    participants: group.participants.map((p) => ({
      label: p.label,
      qualtricsRid: p.qualtricsRid,
      participantId: p.participantId,
      active: p.active,
    })),
    totalTrials: group.trials.length,
    trials: group.trials,
    ruleAnnouncement: group.ruleAnnouncement || null,
    chatLog: group.chatLog,
  };
}

// ─── SUMMARY PARAMS (for Qualtrics redirect) ──────────────────────────────────

/**
 * Produce URL query params to pass back to Qualtrics on completion.
 */
function summaryParams(group, participantLabel) {
  const correct =
    group.ruleAnnouncement && !group.ruleAnnouncement.assessment.flagged;
  return new URLSearchParams({
    task_complete: "1",
    participant_label: participantLabel,
    total_trials: group.trials.length,
    rule_stated: group.ruleAnnouncement
      ? encodeURIComponent(group.ruleAnnouncement.statedRule)
      : "",
    rule_correct_flag: correct ? "1" : "0",
    group_id: group.groupId,
  }).toString();
}

module.exports = {
  addToWaiting,
  removeFromWaiting,
  getWaitingCount,
  tryFormGroup,
  getGroupBySocket,
  getGroup,
  getParticipant,
  addChatMessage,
  normaliseTriple,
  recordSubmission,
  clearSubmission,
  clearAllSubmissions,
  checkConsensus,
  recordTrial,
  isAtRoundCap,
  toggleAnnounceVote,
  clearAnnounceVotes,
  getAnnounceVoteCount,
  getReadyLabels,
  pickRandomActive,
  recordAnnouncement,
  markComplete,
  markDisconnected,
  activeParticipantCount,
  exportSession,
  summaryParams,
  GROUP_SIZE,
  MAX_ROUNDS,
};
