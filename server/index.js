/**
 * Main Server
 *
 * Express serves static files and a single HTML entry point.
 * Socket.io handles all real-time events: matching, chat, trials, announcements.
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const gm = require("./groupManager");
const { evaluate, assessStatedRule, RULE_LABEL } = require("./ruleEvaluator");
const { logSession } = require("./logger");

const PORT = process.env.PORT || 3000;
const QUALTRICS_RETURN_URL = process.env.QUALTRICS_RETURN_URL || "";

// ─── EXPRESS SETUP ────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "..", "public")));

// Single entry point — all routing handled client-side via socket state
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// Researcher endpoint: download today's session log
app.get("/admin/sessions", (req, res) => {
  const adminKey = process.env.ADMIN_KEY || "researcher";
  if (req.query.key !== adminKey) {
    return res.status(403).send("Forbidden");
  }
  const logPath = path.join(__dirname, "..", "logs");
  const fs = require("fs");
  if (!fs.existsSync(logPath)) return res.json([]);
  const files = fs.readdirSync(logPath).filter((f) => f.endsWith(".ndjson"));
  const latest = files.sort().pop();
  if (!latest) return res.json([]);
  const raw = fs.readFileSync(path.join(logPath, latest), "utf8");
  const records = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  res.json(records);
});

// ─── SOCKET.IO EVENTS ─────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`[connect] ${socket.id}`);

  // ── JOIN ──────────────────────────────────────────────────────────────────
  // Client sends { qualtricsRid } on page load
  socket.on("join", ({ qualtricsRid } = {}) => {
    const rid = qualtricsRid || "unknown";
    gm.addToWaiting(socket.id, rid);

    const waiting = gm.getWaitingCount();
    console.log(`[join] rid=${rid} waiting=${waiting}`);

    // Broadcast updated waiting count to everyone in the waiting room
    io.emit("waiting_update", { count: waiting, needed: gm.GROUP_SIZE });

    // Try to form a group
    const group = gm.tryFormGroup();
    if (group) {
      // Put all members in a Socket.io room
      group.participants.forEach((p) => {
        const memberSocket = io.sockets.sockets.get(p.socketId);
        if (memberSocket) memberSocket.join(group.groupId);
      });

      console.log(`[group_formed] groupId=${group.groupId}`);

      // Send each participant their personal info + group start signal
      group.participants.forEach((p) => {
        io.to(p.socketId).emit("group_formed", {
          groupId: group.groupId,
          yourLabel: p.label,
          participants: group.participants.map((x) => x.label),
          round: group.round,
          trials: group.trials,
          chatLog: group.chatLog,
          maxRounds: gm.MAX_ROUNDS,
        });
      });
    }
  });

  // ── CHAT MESSAGE ──────────────────────────────────────────────────────────
  socket.on("chat_message", ({ message } = {}) => {
    const group = gm.getGroupBySocket(socket.id);
    if (!group || group.status !== "active") return;
    if (!message || typeof message !== "string") return;

    const participant = gm.getParticipant(group, socket.id);
    if (!participant) return;

    const trimmed = message.trim().slice(0, 500); // hard length limit
    if (!trimmed) return;

    const entry = gm.addChatMessage(group, participant.label, trimmed);

    io.to(group.groupId).emit("chat_message", entry);
  });

  // ── SUBMIT TRIPLE (with rationale) ───────────────────────────────────────
  // Each participant submits independently. The server collects submissions,
  // then checks for consensus. The triple is only evaluated once all active
  // participants have submitted the same triple.
  socket.on("submit_triple", ({ a, b, c, rationale } = {}) => {
    const group = gm.getGroupBySocket(socket.id);
    if (!group || group.status !== "active") return;
    if (gm.isAtRoundCap(group)) return;

    const participant = gm.getParticipant(group, socket.id);
    if (!participant) return;

    // Validate rationale
    const trimmedRationale = (rationale || "").trim().slice(0, 1000);
    if (!trimmedRationale) {
      socket.emit("submission_error", { message: "Please provide a rationale before submitting." });
      return;
    }

    // Validate and normalise triple
    const nums = gm.normaliseTriple(a, b, c);
    if (!nums) {
      socket.emit("submission_error", { message: "Please enter three valid numbers." });
      return;
    }

    // Record this participant's submission
    gm.recordSubmission(group, socket.id, nums, trimmedRationale);

    const consensus = gm.checkConsensus(group);
    const activeCount = group.participants.filter((p) => p.active).length;

    console.log(
      `[submission] group=${group.groupId} label=${participant.label} ` +
      `triple=${nums} status=${consensus.status} ` +
      `submitted=${group.pendingSubmissions.size}/${activeCount}`
    );

    if (consensus.status === "waiting") {
      // Broadcast updated count to all — no triple values revealed
      io.to(group.groupId).emit("submission_update", {
        submitted: consensus.submitted,
        needed: consensus.needed,
        yourLabel: null, // each client knows their own label already
      });
      // Confirm receipt to the submitter
      socket.emit("submission_received");
      return;
    }

    if (consensus.status === "mismatch") {
      console.log(
        `[mismatch] group=${group.groupId} triples=${JSON.stringify(consensus.triples)}`
      );
      // Clear all submissions so the round restarts cleanly
      gm.clearAllSubmissions(group);
      io.to(group.groupId).emit("submission_mismatch", {
        message:
          "Your group submitted different triples. Please discuss and ensure everyone submits the same triple.",
      });
      return;
    }

    // ── CONSENSUS REACHED ─────────────────────────────────────────────────
    const evalResult = evaluate(consensus.nums[0], consensus.nums[1], consensus.nums[2]);

    // evalResult.valid is always true here — nums are already validated
    const trial = gm.recordTrial(
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
      round: trial.round,
      triple: trial.triple,
      verdict: trial.verdict,
      conforms: trial.conforms,
      atCap: gm.isAtRoundCap(group),
    });
  });

  // ── TOGGLE ANNOUNCE READINESS ─────────────────────────────────────────────
  socket.on("toggle_announce_ready", () => {
    const group = gm.getGroupBySocket(socket.id);
    if (!group || group.status !== "active") return;
    const participant = gm.getParticipant(group, socket.id);
    if (!participant || !participant.active) return;

    gm.toggleAnnounceVote(group, socket.id);

    const active = group.participants.filter((p) => p.active);
    const needed = active.length;
    const readyCount = gm.getAnnounceVoteCount(group);
    const readyLabels = gm.getReadyLabels(group);

    io.to(group.groupId).emit("announce_ready_update", { readyLabels, readyCount, needed });

    if (readyCount >= needed) {
      const chosen = gm.pickRandomActive(group);
      gm.clearAnnounceVotes(group);

      console.log(`[announce_ready] group=${group.groupId} chosen=${chosen.label}`);

      io.to(chosen.socketId).emit("announce_rule_prompt", {});
      active
        .filter((p) => p.socketId !== chosen.socketId)
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

    const trimmed = statedRule.trim().slice(0, 300);
    const assessment = assessStatedRule(trimmed);

    gm.recordAnnouncement(group, trimmed, assessment);
    gm.markComplete(group);

    const session = gm.exportSession(group);
    logSession(session);

    console.log(`[announced] group=${group.groupId} rule="${trimmed}" flagged=${assessment.flagged}`);

    // Send each participant their personalised completion redirect
    group.participants.forEach((p) => {
      const params = gm.summaryParams(group, p.label);
      const returnUrl = QUALTRICS_RETURN_URL
        ? `${QUALTRICS_RETURN_URL}?${params}`
        : null;

      io.to(p.socketId).emit("task_complete", {
        statedRule: trimmed,
        totalTrials: group.trials.length,
        returnUrl,
      });
    });
  });

  // ── DISCONNECT ────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log(`[disconnect] ${socket.id}`);

    gm.removeFromWaiting(socket.id);
    const group = gm.markDisconnected(socket.id);

    if (group && group.status === "active") {
      const remaining = gm.activeParticipantCount(group);
      console.log(`[dropout] group=${group.groupId} remaining=${remaining}`);

      io.to(group.groupId).emit("participant_dropped", {
        remaining,
        needed: gm.GROUP_SIZE,
        message:
          remaining < gm.GROUP_SIZE
            ? "A participant has disconnected. The session may not be able to continue."
            : null,
      });
    }

    // Update waiting room count for everyone still waiting
    io.emit("waiting_update", { count: gm.getWaitingCount(), needed: gm.GROUP_SIZE });
  });
});

// ─── START ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n2-4-6 Task Server running on http://localhost:${PORT}`);
  console.log(`Rule in effect: "${RULE_LABEL}"`);
  console.log(`Group size: ${gm.GROUP_SIZE} | Max rounds: ${gm.MAX_ROUNDS}\n`);
});
