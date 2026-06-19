/**
 * Client — 2-4-6 Task
 *
 * Manages socket events, UI state transitions, and all DOM interactions.
 * No framework — plain JS for maximum compatibility and minimal footprint.
 */

(function () {
  "use strict";

  // ─── STATE ────────────────────────────────────────────────────────────────
  const state = {
    qualtricsRid: null,
    groupId: null,
    yourLabel: null,
    participants: [],
    round: 0,
    maxRounds: 20,
    connected: false,
    isReadyToAnnounce: false,
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
    dots:           document.getElementById("dots"),
    waitingStatus:  document.getElementById("waiting-status"),

    // Header
    sessionLabel:   document.getElementById("session-label"),

    // Task top
    roundBadge:     document.getElementById("round-badge"),
    yourLabelBadge: document.getElementById("your-label-badge"),

    // Feedback banner
    feedbackBanner: document.getElementById("feedback-banner"),

    // History
    historyList:    document.getElementById("history-list"),

    // Chat
    chatMessages:   document.getElementById("chat-messages"),
    chatInput:      document.getElementById("chat-input"),
    chatSendBtn:    document.getElementById("chat-send-btn"),

    // Triple inputs
    tripleA:        document.getElementById("triple-a"),
    tripleB:        document.getElementById("triple-b"),
    tripleC:        document.getElementById("triple-c"),
    rationaleInput: document.getElementById("rationale-input"),
    submissionStatus: document.getElementById("submission-status"),
    tripleSubmitBtn:document.getElementById("triple-submit-btn"),

    // Announce
    announceBtn:        document.getElementById("announce-btn"),
    announceReadyStatus:document.getElementById("announce-ready-status"),
    announceModal:      document.getElementById("announce-modal"),
    announceText:       document.getElementById("announce-text"),
    announceConfirm:    document.getElementById("announce-confirm"),
    announceCancel:     document.getElementById("announce-cancel"),

    // Complete
    completeTrials: document.getElementById("complete-trials"),
    completeRule:   document.getElementById("complete-rule"),
    returnBtn:      document.getElementById("return-btn"),
    redirectNotice: document.getElementById("redirect-notice"),
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

    showScreen("waiting");
    socket.emit("join", { qualtricsRid: state.qualtricsRid });

    if (state.qualtricsRid !== "unknown") {
      el.sessionLabel.textContent = `ID: ${state.qualtricsRid}`;
    }
  }

  // ─── WAITING ROOM ─────────────────────────────────────────────────────────
  socket.on("waiting_update", ({ count, needed }) => {
    // Render dots
    el.dots.innerHTML = "";
    for (let i = 0; i < needed; i++) {
      const dot = document.createElement("div");
      dot.className = "dot" + (i < count ? " filled" : "");
      // Mark the most recently arrived dot as "you" if we just joined
      if (i === count - 1 && !state.groupId) dot.classList.add("you");
      el.dots.appendChild(dot);
    }
    el.waitingStatus.innerHTML =
      `<span class="pulse-ring"></span>` +
      `<strong>${count}</strong> of <strong>${needed}</strong> participants connected — waiting for others to join.`;
  });

  // ─── GROUP FORMED ─────────────────────────────────────────────────────────
  socket.on("group_formed", ({ groupId, yourLabel, participants, round, trials, chatLog, maxRounds }) => {
    state.groupId     = groupId;
    state.yourLabel   = yourLabel;
    state.participants= participants;
    state.round       = round;
    state.maxRounds   = maxRounds;

    el.yourLabelBadge.textContent = yourLabel;
    el.roundBadge.textContent     = `Trial ${round} / ${maxRounds}`;

    // Replay any existing history (reconnect case)
    trials.forEach(addHistoryItem);
    chatLog.forEach((entry) => addChatMessage(entry.label, entry.message));

    showScreen("task");
    appendSystemMessage("Your group is ready. You may begin discussing.");
    el.chatInput.focus();
  });

  // ─── CHAT ─────────────────────────────────────────────────────────────────
  function sendChat() {
    const msg = el.chatInput.value.trim();
    if (!msg) return;
    socket.emit("chat_message", { message: msg });
    el.chatInput.value = "";
  }

  el.chatSendBtn.addEventListener("click", sendChat);
  el.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  socket.on("chat_message", ({ label, message }) => {
    addChatMessage(label, message);
  });

  function addChatMessage(label, message) {
    const isSelf = label === state.yourLabel;
    const div = document.createElement("div");
    div.className = "chat-message" + (isSelf ? " self" : "");

    const labelEl = document.createElement("div");
    labelEl.className = "msg-label";
    labelEl.textContent = label;

    const textEl = document.createElement("div");
    textEl.className = "msg-text";
    textEl.textContent = message;

    div.appendChild(labelEl);
    div.appendChild(textEl);
    el.chatMessages.appendChild(div);
    scrollChatToBottom();
  }

  function appendSystemMessage(message) {
    const div = document.createElement("div");
    div.className = "chat-message system";
    const labelEl = document.createElement("div");
    labelEl.className = "msg-label";
    labelEl.textContent = "—";
    const textEl = document.createElement("div");
    textEl.className = "msg-text";
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

  // Allow Enter to advance between number inputs
  [el.tripleA, el.tripleB].forEach((input, i) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        [el.tripleB, el.tripleC][i].focus();
      }
    });
  });
  el.tripleC.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      el.rationaleInput.focus();
    }
  });

  function submitTriple() {
    const a = el.tripleA.value.trim();
    const b = el.tripleB.value.trim();
    const c = el.tripleC.value.trim();
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
    showSubmissionStatus("waiting-self", "Submission received. Waiting for all group members to submit…");
    socket.emit("submit_triple", { a, b, c, rationale });
  }

  // Lock/unlock the submission form
  function setSubmitLocked(locked) {
    el.tripleA.disabled         = locked;
    el.tripleB.disabled         = locked;
    el.tripleC.disabled         = locked;
    el.rationaleInput.disabled  = locked;
    el.tripleSubmitBtn.disabled = locked;
  }

  // Reset the form for a new round
  function resetSubmissionForm() {
    el.tripleA.value        = "";
    el.tripleB.value        = "";
    el.tripleC.value        = "";
    el.rationaleInput.value = "";
    setSubmitLocked(false);
    clearSubmissionStatus();
    el.tripleA.focus();
  }

  // ── Submission status display ──────────────────────────────────────────────
  function showSubmissionStatus(type, message) {
    el.submissionStatus.textContent = message;
    el.submissionStatus.className   = "submission-status " + type;
    el.submissionStatus.style.display = "block";
  }

  function clearSubmissionStatus() {
    el.submissionStatus.style.display = "none";
    el.submissionStatus.textContent   = "";
    el.submissionStatus.className     = "submission-status";
  }

  // Server: submission received (before consensus)
  socket.on("submission_received", () => {
    // Already showing "waiting" status from submitTriple(); nothing extra needed.
  });

  // Server: updated count (someone else submitted)
  socket.on("submission_update", ({ submitted, needed }) => {
    showSubmissionStatus(
      "waiting-others",
      `Waiting for all members of the group to submit the same triple — ${submitted} of ${needed} submitted.`
    );
  });

  // Server: mismatch — reset so everyone can resubmit
  socket.on("submission_mismatch", ({ message }) => {
    resetSubmissionForm();
    showSubmissionStatus("mismatch", message);
    appendSystemMessage("⚠ " + message);
  });

  // Server: validation error
  socket.on("submission_error", ({ message }) => {
    setSubmitLocked(false);
    showSubmissionStatus("error", message);
  });

  socket.on("trial_result", ({ round, triple, verdict, conforms, atCap }) => {
    state.round = round;
    el.roundBadge.textContent = `Trial ${round} / ${state.maxRounds}`;

    // Reset submission form for next round
    resetSubmissionForm();

    // Update feedback banner
    const banner = el.feedbackBanner;
    banner.className = "feedback-banner verdict-" + verdict.toLowerCase();
    banner.innerHTML =
      `<span class="verdict-label">${verdict}</span>` +
      `<span class="verdict-triple">— ${triple.a}, ${triple.b}, ${triple.c}</span>`;

    // Add to history
    addHistoryItem({ round, triple, verdict, conforms });

    // Announce in chat
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
    // Remove empty state
    const empty = el.historyList.querySelector(".history-empty");
    if (empty) empty.remove();

    const item = document.createElement("div");
    item.className = "history-item " + (conforms ? "yes" : "no");

    const roundEl = document.createElement("span");
    roundEl.className = "round-num";
    roundEl.textContent = round;

    const tripleEl = document.createElement("span");
    tripleEl.className = "triple-display";
    tripleEl.textContent = `${triple.a}, ${triple.b}, ${triple.c}`;

    const pillEl = document.createElement("span");
    pillEl.className = "verdict-pill";
    pillEl.textContent = verdict;

    item.appendChild(roundEl);
    item.appendChild(tripleEl);
    item.appendChild(pillEl);
    el.historyList.appendChild(item);
    el.historyList.scrollTop = el.historyList.scrollHeight;
  }

  // ─── RULE ANNOUNCEMENT ────────────────────────────────────────────────────

  function resetAnnounceState() {
    state.isReadyToAnnounce = false;
    state.waitingForAnnouncer = false;
    el.announceBtn.textContent = "Announce rule";
    el.announceBtn.className = "btn-danger btn-sm";
    el.announceBtn.disabled = false;
    el.announceReadyStatus.style.display = "none";
    el.announceReadyStatus.textContent = "";
  }

  // Clicking "Announce rule" toggles this participant's readiness vote
  el.announceBtn.addEventListener("click", () => {
    if (state.waitingForAnnouncer) return;
    socket.emit("toggle_announce_ready");
  });

  // Server broadcasts readiness vote state to all group members
  socket.on("announce_ready_update", ({ readyLabels, readyCount, needed }) => {
    state.isReadyToAnnounce = readyLabels.includes(state.yourLabel);
    el.announceBtn.textContent = state.isReadyToAnnounce ? "Cancel readiness" : "Announce rule";
    el.announceBtn.className = state.isReadyToAnnounce ? "btn-secondary btn-sm" : "btn-danger btn-sm";

    if (readyCount > 0) {
      el.announceReadyStatus.textContent = `${readyCount} / ${needed} ready to announce`;
      el.announceReadyStatus.style.display = "block";
    } else {
      el.announceReadyStatus.style.display = "none";
    }
  });

  // This participant was randomly chosen to type the rule
  socket.on("announce_rule_prompt", () => {
    state.waitingForAnnouncer = true;
    el.announceReadyStatus.style.display = "none";
    el.announceConfirm.disabled = false;
    el.announceModal.classList.add("open");
    el.announceText.focus();
  });

  // Another participant was chosen — wait for them
  socket.on("announce_rule_waiting", ({ announcerLabel }) => {
    state.waitingForAnnouncer = true;
    el.announceBtn.disabled = true;
    el.announceReadyStatus.style.display = "none";
    appendSystemMessage(`All members ready! ${announcerLabel} has been chosen to state the rule.`);
  });

  // Chosen announcer cancelled — reset everyone
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

  // Close modal on overlay click (treated as cancel)
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
      el.returnBtn.style.display = "inline-flex";
      el.returnBtn.addEventListener("click", () => { window.location.href = returnUrl; });
      setTimeout(() => { window.location.href = returnUrl; }, 5000);
    } else {
      el.redirectNotice.textContent = "You may now close this window.";
    }

    showScreen("complete");
  });

  // ─── DROPOUT NOTICE ───────────────────────────────────────────────────────
  socket.on("participant_dropped", ({ remaining, needed, message }) => {
    if (message) {
      appendSystemMessage(message);
    }
  });

  // ─── CONNECTION LIFECYCLE ─────────────────────────────────────────────────
  socket.on("connect", () => {
    state.connected = true;
  });

  socket.on("disconnect", () => {
    state.connected = false;
    if (state.groupId) {
      appendSystemMessage("Connection lost. Please refresh the page.");
    }
  });

  // ─── START ────────────────────────────────────────────────────────────────
  init();
})();
