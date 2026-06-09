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

  // ── PROPOSE TRIPLE ────────────────────────────────────────────────────────
  socket.on("propose_triple", ({ a, b, c } = {}) => {
    const group = gm.getGroupBySocket(socket.id);
    if (!group || group.status !== "active") return;
    if (gm.isAtRoundCap(group)) return;

    const result = evaluate(a, b, c);

    if (!result.valid) {
      socket.emit("triple_invalid", { message: result.verdict });
      return;
    }

    const trial = gm.recordTrial(group, { a: result.nums[0], b: result.nums[1], c: result.nums[2] }, result);

    console.log(
      `[trial] group=${group.groupId} round=${trial.round} triple=${result.nums} verdict=${result.verdict}`
    );

    // Broadcast verdict to whole group
    io.to(group.groupId).emit("trial_result", {
      round: trial.round,
      triple: trial.triple,
      verdict: trial.verdict,
      conforms: trial.conforms,
      atCap: gm.isAtRoundCap(group),
    });
  });

  // ── ANNOUNCE RULE ─────────────────────────────────────────────────────────
  socket.on("announce_rule", ({ statedRule } = {}) => {
    const group = gm.getGroupBySocket(socket.id);
    if (!group || group.status !== "active") return;
    if (!statedRule || typeof statedRule !== "string") return;

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
