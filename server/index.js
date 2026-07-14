/**
 * Main Server
 *
 * Two waiting queues:
 *   control     — 4-person groups, all agree on triples
 *   adversarial — 1 left-brain (blue) + 1 right-brain (red) pair,
 *                 same consensus rules as control
 */

const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const path    = require("path");

const gm                                         = require("./groupManager");
const { evaluate, assessStatedRule, RULE_LABEL } = require("./ruleEvaluator");
const { logSession }                             = require("./logger");

const PORT                 = process.env.PORT || 3000;
const QUALTRICS_RETURN_URL = process.env.QUALTRICS_RETURN_URL || "";

// ─── EXPRESS SETUP ────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/admin/sessions", (req, res) => {
  const adminKey = process.env.ADMIN_KEY || "researcher";
  if (req.query.key !== adminKey) return res.status(403).send("Forbidden");
  const logPath = path.join(__dirname, "..", "logs");
  const fs      = require("fs");
  if (!fs.existsSync(logPath)) return res.json([]);
  const files  = fs.readdirSync(logPath).filter((f) => f.endsWith(".ndjson"));
  const latest = files.sort().pop();
  if (!latest) return res.json([]);
  const raw     = fs.readFileSync(path.join(logPath, latest), "utf8");
  const records = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  res.json(records);
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function broadcastControlWaiting() {
  const count = gm.getWaitingCount();
  gm.getWaitingSocketIds().forEach((sid) => {
    io.to(sid).emit("waiting_update", {
      condition: "control",
      count,
      needed: gm.GROUP_SIZE,
    });
  });
}

function broadcastAdversarialWaiting() {
  const counts = gm.getAdversarialWaitingCounts();
  gm.getAdversarialWaitingSocketIds().forEach((sid) => {
    io.to(sid).emit("waiting_update", {
      condition: "adversarial",
      team:      gm.getAdversarialWaitingTeam(sid),
      counts,
      needed:    gm.ADVERSARIAL_GROUP_SIZE,
    });
  });
}

function emitControlGroupFormed(group) {
  group.participants.forEach((p) => {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.join(group.groupId);
  });

  group.participants.forEach((p) => {
    io.to(p.socketId).emit("group_formed", {
      groupId:      group.groupId,
      yourLabel:    p.label,
      yourTeam:     null,
      condition:    "control",
      participants: group.participants.map((x) => x.label),
      teams:        null,
      round:        group.round,
      trials:       group.trials,
      chatLog:      group.chatLog,
      maxRounds:    gm.MAX_ROUNDS,
      activeCounts: gm.getActiveCountsByTeam(group),
    });
  });

  console.log(`[group_formed] groupId=${group.groupId} condition=control`);
}

function emitAdversarialGroupFormed(group) {
  group.participants.forEach((p) => {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.join(group.groupId);
  });

  const teamLabels = {
    blue: group.participants.filter((x) => group.teams.blue.includes(x.socketId)).map((x) => x.label),
    red:  group.participants.filter((x) => group.teams.red.includes(x.socketId)).map((x) => x.label),
  };

  group.participants.forEach((p) => {
    io.to(p.socketId).emit("group_formed", {
      groupId:      group.groupId,
      yourLabel:    p.label,
      yourTeam:     p.team,
      condition:    "adversarial",
      participants: group.participants.map((x) => x.label),
      teams:        teamLabels,
      round:        group.round,
      trials:       group.trials,
      chatLog:      group.chatLog,
      maxRounds:    gm.MAX_ROUNDS,
      activeCounts: gm.getActiveCountsByTeam(group),
    });
  });

  console.log(`[group_formed] groupId=${group.groupId} condition=adversarial`);
}

// ─── SOCKET.IO EVENTS ─────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`[connect] ${socket.id}`);

  // ── JOIN ──────────────────────────────────────────────────────────────────
  socket.on("join", ({ qualtricsRid, condition, team } = {}) => {
    const rid  = qualtricsRid || "unknown";
    const cond = condition === "adversarial" ? "adversarial" : "control";

    if (cond === "adversarial") {
      const teamMap = { left: "blue", right: "red" };
      const t = teamMap[team] || "blue";
      gm.addToAdversarialWaiting(socket.id, rid, t);
      console.log(`[join] rid=${rid} condition=adversarial team=${t} waiting=${JSON.stringify(gm.getAdversarialWaitingCounts())}`);
      broadcastAdversarialWaiting();

      let formed;
      while ((formed = gm.tryFormAdversarialGroup()) !== null) {
        emitAdversarialGroupFormed(formed);
      }
      broadcastAdversarialWaiting(); // update any remaining waiters with corrected counts
    } else {
      gm.addToWaiting(socket.id, rid);
      console.log(`[join] rid=${rid} condition=control waiting=${gm.getWaitingCount()}`);
      broadcastControlWaiting();

      const group = gm.tryFormGroup();
      if (group) emitControlGroupFormed(group);
    }
  });

  // ── CHAT MESSAGE ──────────────────────────────────────────────────────────
  socket.on("chat_message", ({ message } = {}) => {
    const group = gm.getGroupBySocket(socket.id);
    if (!group || group.status !== "active") return;
    if (!message || typeof message !== "string") return;

    const participant = gm.getParticipant(group, socket.id);
    if (!participant) return;

    const trimmed = message.trim().slice(0, 500);
    if (!trimmed) return;

    const entry = gm.addChatMessage(group, participant.label, trimmed);
    io.to(group.groupId).emit("chat_message", entry);
  });

  // ── SUBMIT TRIPLE ─────────────────────────────────────────────────────────
  socket.on("submit_triple", ({ a, b, c, rationale } = {}) => {
    const group = gm.getGroupBySocket(socket.id);
    if (!group || group.status !== "active") return;
    if (gm.isAtRoundCap(group)) return;

    const participant = gm.getParticipant(group, socket.id);
    if (!participant) return;

    const trimmedRationale = (rationale || "").trim().slice(0, 1000);
    if (!trimmedRationale) {
      socket.emit("submission_error", { message: "Please provide a rationale before submitting." });
      return;
    }

    const nums = gm.normaliseTriple(a, b, c);
    if (!nums) {
      socket.emit("submission_error", { message: "Please enter three valid numbers." });
      return;
    }

    gm.recordSubmission(group, socket.id, nums, trimmedRationale);

    const consensus   = gm.checkConsensus(group);
    const activeCount = group.participants.filter((p) => p.active).length;

    console.log(
      `[submission] group=${group.groupId} label=${participant.label} ` +
      `triple=${nums} status=${consensus.status} ` +
      `submitted=${group.pendingSubmissions.size}/${activeCount}`
    );

    if (consensus.status === "waiting") {
      io.to(group.groupId).emit("submission_update", {
        submitted: consensus.submitted,
        needed:    consensus.needed,
      });
      socket.emit("submission_received");
      return;
    }

    if (consensus.status === "mismatch") {
      console.log(`[mismatch] group=${group.groupId} triples=${JSON.stringify(consensus.triples)}`);
      gm.clearAllSubmissions(group);
      io.to(group.groupId).emit("submission_mismatch", {
        message: "Your group submitted different triples. Please discuss and ensure everyone submits the same triple.",
      });
      return;
    }

    // ── CONSENSUS REACHED ─────────────────────────────────────────────────
    const evalResult = evaluate(consensus.nums[0], consensus.nums[1], consensus.nums[2]);
    const trial      = gm.recordTrial(
      group,
      { a: consensus.nums[0], b: consensus.nums[1], c: consensus.nums[2] },
      consensus.rationales,
      evalResult
    );

    console.log(
      `[trial] group=${group.groupId} round=${trial.round} ` +
      `triple=${consensus.nums} verdict=${trial.verdict}`
    );

    io.to(group.groupId).emit("trial_result", {
      round:        trial.round,
      triple:       trial.triple,
      verdict:      trial.verdict,
      conforms:     trial.conforms,
      atCap:        gm.isAtRoundCap(group),
      activeCounts: gm.getActiveCountsByTeam(group),
    });
  });

  // ── TOGGLE ANNOUNCE READINESS ─────────────────────────────────────────────
  socket.on("toggle_announce_ready", () => {
    const group = gm.getGroupBySocket(socket.id);
    if (!group || group.status !== "active") return;
    const participant = gm.getParticipant(group, socket.id);
    if (!participant || !participant.active) return;

    gm.toggleAnnounceVote(group, socket.id);

    const needed      = gm.announceThreshold(group);
    const readyCount  = gm.getAnnounceVoteCount(group);
    const readyLabels = gm.getReadyLabels(group);

    io.to(group.groupId).emit("announce_ready_update", { readyLabels, readyCount, needed });

    if (readyCount >= needed) {
      const chosen = gm.pickRandomActive(group);
      gm.clearAnnounceVotes(group);

      console.log(`[announce_ready] group=${group.groupId} chosen=${chosen.label}`);

      io.to(chosen.socketId).emit("announce_rule_prompt", {});
      group.participants
        .filter((p) => p.active && p.socketId !== chosen.socketId)
        .forEach((p) => {
          io.to(p.socketId).emit("announce_rule_waiting", { announcerLabel: chosen.label });
        });
    }
  });

  // ── CANCEL ANNOUNCE ───────────────────────────────────────────────────────
  socket.on("cancel_announce", () => {
    const group = gm.getGroupBySocket(socket.id);
    if (!group || group.status !== "active") return;
    gm.clearAnnounceVotes(group);
    console.log(`[announce_cancelled] group=${group.groupId}`);
    io.to(group.groupId).emit("announce_ready_reset", {});
  });

  // ── ANNOUNCE RULE ─────────────────────────────────────────────────────────
  socket.on("announce_rule", ({ statedRule } = {}) => {
    const group = gm.getGroupBySocket(socket.id);
    if (!group || group.status !== "active") return;
    if (!statedRule || typeof statedRule !== "string") return;

    gm.clearAnnounceVotes(group);

    const trimmed    = statedRule.trim().slice(0, 300);
    const assessment = assessStatedRule(trimmed);

    gm.recordAnnouncement(group, trimmed, assessment);
    gm.markComplete(group);

    const session = gm.exportSession(group);
    logSession(session);

    console.log(`[announced] group=${group.groupId} rule="${trimmed}" flagged=${assessment.flagged}`);

    group.participants.forEach((p) => {
      const params    = gm.summaryParams(group, p.label);
      const returnUrl = QUALTRICS_RETURN_URL ? `${QUALTRICS_RETURN_URL}?${params}` : null;
      io.to(p.socketId).emit("task_complete", {
        statedRule:  trimmed,
        totalTrials: group.trials.length,
        returnUrl,
      });
    });
  });

  // ── DISCONNECT ────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log(`[disconnect] ${socket.id}`);

    const wasAdversarialWaiting = gm.isInAdversarialWaiting(socket.id);

    gm.removeFromWaiting(socket.id);
    gm.removeFromAdversarialWaiting(socket.id);

    const group = gm.markDisconnected(socket.id);

    if (group && group.status === "active") {
      const remaining = gm.activeParticipantCount(group);
      const needed    = group.condition === "adversarial" ? gm.ADVERSARIAL_GROUP_SIZE : gm.GROUP_SIZE;
      console.log(`[dropout] group=${group.groupId} remaining=${remaining}`);

      io.to(group.groupId).emit("participant_dropped", {
        remaining,
        needed,
        message: remaining < needed
          ? "A participant has disconnected. The session may not be able to continue."
          : null,
        activeCounts: gm.getActiveCountsByTeam(group),
      });
    }

    if (wasAdversarialWaiting) {
      broadcastAdversarialWaiting();
    } else {
      broadcastControlWaiting();
    }
  });
});

// ─── START ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n2-4-6 Task Server running on http://localhost:${PORT}`);
  console.log(`Rule in effect: "${RULE_LABEL}"`);
  console.log(`Control group size: ${gm.GROUP_SIZE} | Adversarial pair size: ${gm.ADVERSARIAL_GROUP_SIZE} | Max rounds: ${gm.MAX_ROUNDS}\n`);
});
