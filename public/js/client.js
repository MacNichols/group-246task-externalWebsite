/**
 * Client — 2-4-6 Task
 *
 * Manages socket events, UI state transitions, and all DOM interactions.
 * Supports two conditions passed via URL params:
 *   control     — ?rid=...
 *   adversarial — ?rid=...&condition=adversarial&team=blue|red
 */

(function () {
  "use strict";

  // ─── STATE ────────────────────────────────────────────────────────────────
  const state = {
    qualtricsRid:        null,
    condition:           "control",
    yourTeam:            null,
    groupId:             null,
    yourLabel:           null,
    participants:        [],
    teams:               null,      // { blue: [labels], red: [labels] }
    currentTurn:         null,      // "blue" | "red" | null
    round:               0,
    maxRounds:           20,
    connected:           false,
    isReadyToAnnounce:   false,
    waitingForAnnouncer: false,
  };

  // ─── SOCKET ───────────────────────────────────────────────────────────────
  const socket = io();

  // ─── DOM REFS ─────────────────────────────────────────────────────────────
  const screens = {
    waiting:  document.getElementById("screen-waiting"),
    task:     document.getElementById("screen-task"),
    complete: document.getElementById("screen-complete"),
  };

  const el = {
    // Waiting
    waitingTeamBadge: document.getElementById("waiting-team-badge"),
    dots:             document.getElementById("dots"),
    waitingStatus:    document.getElementById("waiting-status"),

    // Header
    sessionLabel:     document.getElementById("session-label"),

    // Task top
    roundBadge:       document.getElementById("round-badge"),
    yourLabelBadge:   document.getElementById("your-label-badge"),
    activeCountBadge: document.getElementById("active-count-badge"),
    teamBadge:        document.getElementById("team-badge"),

    // Turn indicator
    turnIndicator:    document.getElementById("turn-indicator"),

    // Feedback banner
    feedbackBanner:   document.getElementById("feedback-banner"),

    // History
    historyList:      document.getElementById("history-list"),

    // Chat
    chatMessages:     document.getElementById("chat-messages"),
    chatInput:        document.getElementById("chat-input"),
    chatSendBtn:      document.getElementById("chat-send-btn"),

    // Triple inputs
    tripleA:          document.getElementById("triple-a"),
    tripleB:          document.getElementById("triple-b"),
    tripleC:          document.getElementById("triple-c"),
    rationaleInput:   document.getElementById("rationale-input"),
    submissionStatus: document.getElementById("submission-status"),
    tripleSubmitBtn:  document.getElementById("triple-submit-btn"),

    // Announce
    announceBtn:         document.getElementById("announce-btn"),
    announceReadyStatus: document.getElementById("announce-ready-status"),
    announceModal:       document.getElementById("announce-modal"),
    announceText:        document.getElementById("announce-text"),
    announceConfirm:     document.getElementById("announce-confirm"),
    announceCancel:      document.getElementById("announce-cancel"),

    // Complete
    completeTrials:  document.getElementById("complete-trials"),
    completeRule:    document.getElementById("complete-rule"),
    returnBtn:       document.getElementById("return-btn"),
    redirectNotice:  document.getElementById("redirect-notice"),
  };

  // ─── SCREEN TRANSITIONS ───────────────────────────────────────────────────
  function showScreen(name) {
    Object.entries(screens).forEach(([key, node]) => {
      node.classList.toggle("active", key === name);
    });
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────
  function init() {
    const params = new URLSearchParams(window.location.search);
    state.qualtricsRid = params.get("rid") || "unknown";
    state.condition    = params.get("condition") === "adversarial" ? "adversarial" : "control";
    state.yourTeam     = params.get("team") || null;

    showScreen("waiting");
    socket.emit("join", {
      qualtricsRid: state.qualtricsRid,
      condition:    state.condition,
      team:         state.yourTeam,
    });

    if (state.qualtricsRid !== "unknown") {
      el.sessionLabel.textContent = `ID: ${state.qualtricsRid}`;
    }
  }

  // ─── WAITING ROOM ─────────────────────────────────────────────────────────
  socket.on("waiting_update", ({ condition, count, needed, counts, team }) => {
    if (condition === "adversarial") {
      // Show team badge
      el.waitingTeamBadge.textContent = team === "blue" ? "Blue Team" : "Red Team";
      el.waitingTeamBadge.className   = "team-badge team-badge-" + team;
      el.waitingTeamBadge.style.display = "inline-flex";

      // Render two sets of dots separated by a divider
      el.dots.innerHTML = "";
      for (let i = 0; i < 2; i++) {
        const dot = document.createElement("div");
        dot.className = "dot dot-blue" + (i < counts.blue ? " filled" : "");
        if (team === "blue" && i === counts.blue - 1 && !state.groupId) dot.classList.add("you");
        el.dots.appendChild(dot);
      }
      const sep = document.createElement("span");
      sep.className = "dot-sep";
      sep.textContent = "·";
      el.dots.appendChild(sep);
      for (let i = 0; i < 2; i++) {
        const dot = document.createElement("div");
        dot.className = "dot dot-red" + (i < counts.red ? " filled" : "");
        if (team === "red" && i === counts.red - 1 && !state.groupId) dot.classList.add("you");
        el.dots.appendChild(dot);
      }

      el.waitingStatus.innerHTML =
        `<span class="pulse-ring"></span>` +
        `Blue <strong>${counts.blue}/2</strong> · Red <strong>${counts.red}/2</strong> — waiting for a full group.`;
    } else {
      el.waitingTeamBadge.style.display = "none";
      el.dots.innerHTML = "";
      for (let i = 0; i < needed; i++) {
        const dot = document.createElement("div");
        dot.className = "dot" + (i < count ? " filled" : "");
        if (i === count - 1 && !state.groupId) dot.classList.add("you");
        el.dots.appendChild(dot);
      }
      el.waitingStatus.innerHTML =
        `<span class="pulse-ring"></span>` +
        `<strong>${count}</strong> of <strong>${needed}</strong> participants connected — waiting for others to join.`;
    }
  });

  // ─── GROUP FORMED ─────────────────────────────────────────────────────────
  socket.on("group_formed", ({
    groupId, yourLabel, yourTeam, condition, participants,
    teams, currentTurn, round, trials, chatLog, maxRounds, activeCounts,
  }) => {
    state.groupId      = groupId;
    state.yourLabel    = yourLabel;
    state.yourTeam     = yourTeam;
    state.condition    = condition;
    state.participants = participants;
    state.teams        = teams;
    state.currentTurn  = currentTurn;
    state.round        = round;
    state.maxRounds    = maxRounds;

    el.yourLabelBadge.textContent = yourLabel;
    el.roundBadge.textContent     = `Trial ${round} / ${maxRounds}`;

    // Active participant display
    updateActiveCountDisplay(activeCounts);

    // Team badge + turn indicator (adversarial only)
    if (condition === "adversarial") {
      renderTeamBadge(yourTeam);
      updateTurnUI(currentTurn);
    }

    trials.forEach(addHistoryItem);
    chatLog.forEach((entry) => addChatMessage(entry.label, entry.message));

    showScreen("task");
    appendSystemMessage("Your group is ready. You may begin discussing.");
    el.chatInput.focus();
  });

  // ─── TEAM / TURN UI ───────────────────────────────────────────────────────
  function renderTeamBadge(team) {
    el.teamBadge.textContent    = team === "blue" ? "Blue Team" : "Red Team";
    el.teamBadge.className      = "team-badge team-badge-" + team;
    el.teamBadge.style.display  = "inline-flex";
  }

  function updateTurnUI(currentTurn) {
    const isMyTurn = currentTurn === state.yourTeam;
    const teamName = currentTurn === "blue" ? "Blue" : "Red";

    el.turnIndicator.className    = "turn-indicator turn-" + currentTurn;
    el.turnIndicator.style.display = "flex";

    if (isMyTurn) {
      el.turnIndicator.textContent = "Your team's turn to propose a triple.";
      setSubmitLocked(false);
      clearSubmissionStatus();
    } else {
      el.turnIndicator.textContent = `${teamName} team's turn to propose a triple.`;
      setSubmitLocked(true);
      showSubmissionStatus("waiting-others", `Waiting for the ${teamName} team to propose…`);
    }
  }

  function updateActiveCountDisplay(activeCounts) {
    if (!activeCounts) return;
    if (state.condition === "adversarial") {
      el.activeCountBadge.textContent = `Blue ${activeCounts.blue}/2 · Red ${activeCounts.red}/2`;
    } else {
      el.activeCountBadge.textContent = `${activeCounts.total} / ${activeCounts.max} active`;
    }
    el.activeCountBadge.style.display = "inline-flex";
  }

  // ─── CHAT ─────────────────────────────────────────────────────────────────
  function sendChat() {
    const msg = el.chatInput.value.trim();
    if (!msg) return;
    socket.emit("chat_message", { message: msg });
    el.chatInput.value = "";
  }

  el.chatSendBtn.addEventListener("click", sendChat);
  el.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  socket.on("chat_message", ({ label, message }) => {
    addChatMessage(label, message);
  });

  function getTeamForLabel(label) {
    if (state.condition !== "adversarial" || !state.teams) return null;
    if (state.teams.blue.includes(label)) return "blue";
    if (state.teams.red.includes(label))  return "red";
    return null;
  }

  function addChatMessage(label, message) {
    const isSelf = label === state.yourLabel;
    const div    = document.createElement("div");
    div.className = "chat-message" + (isSelf ? " self" : "");

    const labelEl = document.createElement("div");
    const team    = getTeamForLabel(label);
    labelEl.className   = "msg-label" + (team ? " team-" + team : "");
    labelEl.textContent = label;

    const textEl = document.createElement("div");
    textEl.className   = "msg-text";
    textEl.textContent = message;

    div.appendChild(labelEl);
    div.appendChild(textEl);
    el.chatMessages.appendChild(div);
    scrollChatToBottom();
  }

  function appendSystemMessage(message) {
    const div     = document.createElement("div");
    div.className = "chat-message system";
    const labelEl = document.createElement("div");
    labelEl.className   = "msg-label";
    labelEl.textContent = "—";
    const textEl  = document.createElement("div");
    textEl.className   = "msg-text";
    textEl.textContent = message;
    div.appendChild(labelEl);
    div.appendChild(textEl);
    el.chatMessages.appendChild(div);
    scrollChatToBottom();
  }

  function scrollChatToBottom() {
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  }

  // ─── TRIPLE SUBMISSION ────────────────────────────────────────────────────
  el.tripleSubmitBtn.addEventListener("click", submitTriple);

  [el.tripleA, el.tripleB].forEach((input, i) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); [el.tripleB, el.tripleC][i].focus(); }
    });
  });
  el.tripleC.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); el.rationaleInput.focus(); }
  });

  function submitTriple() {
    const a         = el.tripleA.value.trim();
    const b         = el.tripleB.value.trim();
    const c         = el.tripleC.value.trim();
    const rationale = el.rationaleInput.value.trim();

    if (!a || !b || !c) {
      showSubmissionStatus("error", "Please enter all three numbers.");
      return;
    }
    if (!rationale) {
      showSubmissionStatus("error", "Please provide a rationale for your triple.");
      el.rationaleInput.focus();
      return;
    }

    setSubmitLocked(true);
    showSubmissionStatus("waiting-self", "Submission received. Waiting for your team to submit…");
    socket.emit("submit_triple", { a, b, c, rationale });
  }

  function setSubmitLocked(locked) {
    el.tripleA.disabled          = locked;
    el.tripleB.disabled          = locked;
    el.tripleC.disabled          = locked;
    el.rationaleInput.disabled   = locked;
    el.tripleSubmitBtn.disabled  = locked;
  }

  function resetSubmissionForm() {
    el.tripleA.value        = "";
    el.tripleB.value        = "";
    el.tripleC.value        = "";
    el.rationaleInput.value = "";
    setSubmitLocked(false);
    clearSubmissionStatus();
    el.tripleA.focus();
  }

  function showSubmissionStatus(type, message) {
    el.submissionStatus.textContent    = message;
    el.submissionStatus.className      = "submission-status " + type;
    el.submissionStatus.style.display  = "block";
  }

  function clearSubmissionStatus() {
    el.submissionStatus.style.display = "none";
    el.submissionStatus.textContent   = "";
    el.submissionStatus.className     = "submission-status";
  }

  socket.on("submission_received", () => {
    // Status already set in submitTriple(); nothing extra needed.
  });

  socket.on("submission_update", ({ submitted, needed }) => {
    showSubmissionStatus(
      "waiting-others",
      `Waiting for all team members to submit the same triple — ${submitted} of ${needed} submitted.`
    );
  });

  socket.on("submission_mismatch", ({ message }) => {
    resetSubmissionForm();
    showSubmissionStatus("mismatch", message);
    appendSystemMessage("⚠ " + message);
  });

  socket.on("submission_error", ({ message }) => {
    setSubmitLocked(false);
    showSubmissionStatus("error", message);
  });

  socket.on("trial_result", ({ round, triple, verdict, conforms, atCap, currentTurn, activeCounts }) => {
    state.round = round;
    el.roundBadge.textContent = `Trial ${round} / ${state.maxRounds}`;

    // Reset form, then re-apply turn lock if adversarial
    resetSubmissionForm();

    if (state.condition === "adversarial" && currentTurn !== null) {
      state.currentTurn = currentTurn;
      updateTurnUI(currentTurn);
    }

    if (activeCounts) updateActiveCountDisplay(activeCounts);

    // Update feedback banner
    const banner = el.feedbackBanner;
    banner.className = "feedback-banner verdict-" + verdict.toLowerCase();
    banner.innerHTML =
      `<span class="verdict-label">${verdict}</span>` +
      `<span class="verdict-triple">— ${triple.a}, ${triple.b}, ${triple.c}</span>`;

    addHistoryItem({ round, triple, verdict, conforms });

    const msg = verdict === "Yes"
      ? `✓ ${triple.a}, ${triple.b}, ${triple.c} → Yes`
      : `✗ ${triple.a}, ${triple.b}, ${triple.c} → No`;
    appendSystemMessage(msg);

    if (atCap) {
      appendSystemMessage("You have reached the maximum number of trials. Please announce your rule.");
      setSubmitLocked(true);
    }
  });

  function addHistoryItem({ round, triple, verdict, conforms }) {
    const empty = el.historyList.querySelector(".history-empty");
    if (empty) empty.remove();

    const item = document.createElement("div");
    item.className = "history-item " + (conforms ? "yes" : "no");

    const roundEl  = document.createElement("span");
    roundEl.className   = "round-num";
    roundEl.textContent = round;

    const tripleEl = document.createElement("span");
    tripleEl.className   = "triple-display";
    tripleEl.textContent = `${triple.a}, ${triple.b}, ${triple.c}`;

    const pillEl   = document.createElement("span");
    pillEl.className   = "verdict-pill";
    pillEl.textContent = verdict;

    item.appendChild(roundEl);
    item.appendChild(tripleEl);
    item.appendChild(pillEl);
    el.historyList.appendChild(item);
    el.historyList.scrollTop = el.historyList.scrollHeight;
  }

  // ─── RULE ANNOUNCEMENT ────────────────────────────────────────────────────

  function resetAnnounceState() {
    state.isReadyToAnnounce   = false;
    state.waitingForAnnouncer = false;
    el.announceBtn.textContent = "Announce rule";
    el.announceBtn.className   = "btn-danger btn-sm";
    el.announceBtn.disabled    = false;
    el.announceReadyStatus.style.display = "none";
    el.announceReadyStatus.textContent   = "";
  }

  el.announceBtn.addEventListener("click", () => {
    if (state.waitingForAnnouncer) return;
    socket.emit("toggle_announce_ready");
  });

  socket.on("announce_ready_update", ({ readyLabels, readyCount, needed }) => {
    state.isReadyToAnnounce    = readyLabels.includes(state.yourLabel);
    el.announceBtn.textContent = state.isReadyToAnnounce ? "Cancel readiness" : "Announce rule";
    el.announceBtn.className   = state.isReadyToAnnounce ? "btn-secondary btn-sm" : "btn-danger btn-sm";

    if (readyCount > 0) {
      el.announceReadyStatus.textContent   = `${readyCount} / ${needed} ready to announce`;
      el.announceReadyStatus.style.display = "block";
    } else {
      el.announceReadyStatus.style.display = "none";
    }
  });

  socket.on("announce_rule_prompt", () => {
    state.waitingForAnnouncer    = true;
    el.announceReadyStatus.style.display = "none";
    el.announceConfirm.disabled  = false;
    el.announceModal.classList.add("open");
    el.announceText.focus();
  });

  socket.on("announce_rule_waiting", ({ announcerLabel }) => {
    state.waitingForAnnouncer  = true;
    el.announceBtn.disabled    = true;
    el.announceReadyStatus.style.display = "none";
    appendSystemMessage(`Majority reached! ${announcerLabel} has been chosen to state the rule.`);
  });

  socket.on("announce_ready_reset", () => {
    resetAnnounceState();
    appendSystemMessage("The announcement was cancelled. You may continue testing.");
  });

  el.announceCancel.addEventListener("click", () => {
    el.announceModal.classList.remove("open");
    el.announceText.value = "";
    socket.emit("cancel_announce");
  });

  el.announceConfirm.addEventListener("click", () => {
    const rule = el.announceText.value.trim();
    if (!rule) return;
    el.announceConfirm.disabled = true;
    socket.emit("announce_rule", { statedRule: rule });
    el.announceModal.classList.remove("open");
  });

  el.announceModal.addEventListener("click", (e) => {
    if (e.target === el.announceModal) {
      el.announceModal.classList.remove("open");
      el.announceText.value = "";
      socket.emit("cancel_announce");
    }
  });

  // ─── TASK COMPLETE ────────────────────────────────────────────────────────
  socket.on("task_complete", ({ statedRule, totalTrials, returnUrl }) => {
    el.completeTrials.textContent = totalTrials;
    el.completeRule.textContent   = statedRule;

    if (returnUrl) {
      el.redirectNotice.textContent = "Returning you to the survey in 5 seconds…";
      el.returnBtn.style.display    = "inline-flex";
      el.returnBtn.addEventListener("click", () => { window.location.href = returnUrl; });
      setTimeout(() => { window.location.href = returnUrl; }, 5000);
    } else {
      el.redirectNotice.textContent = "You may now close this window.";
    }

    showScreen("complete");
  });

  // ─── DROPOUT NOTICE ───────────────────────────────────────────────────────
  socket.on("participant_dropped", ({ message, activeCounts }) => {
    if (message) appendSystemMessage(message);
    if (activeCounts) updateActiveCountDisplay(activeCounts);
  });

  // ─── CONNECTION LIFECYCLE ─────────────────────────────────────────────────
  socket.on("connect", () => { state.connected = true; });

  socket.on("disconnect", () => {
    state.connected = false;
    if (state.groupId) appendSystemMessage("Connection lost. Please refresh the page.");
  });

  // ─── START ────────────────────────────────────────────────────────────────
  init();
})();
