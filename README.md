# 2-4-6 Task — Group Hypothesis Testing

A standalone web application for running the group 2-4-6 task online.
Handles real-time participant matching, group chat, triple evaluation, and
session logging. Designed to integrate with Qualtrics surveys via URL parameters.

---

## Quick Start

```bash
npm install
npm start
```

Server runs at `http://localhost:3000`.

For development with auto-restart:
```bash
npm run dev
```

---

## Configuration

All configuration is done via environment variables or by editing the source
files directly (noted below).

### Environment variables

| Variable               | Default       | Description                                           |
|------------------------|---------------|-------------------------------------------------------|
| `PORT`                 | `3000`        | HTTP port                                             |
| `QUALTRICS_RETURN_URL` | *(empty)*     | Full URL of your Qualtrics survey return link         |
| `ADMIN_KEY`            | `researcher`  | Key for accessing the `/admin/sessions` endpoint      |

Example:
```bash
PORT=3000 \
QUALTRICS_RETURN_URL="https://youruni.qualtrics.com/jfe/form/SV_xxxxxxxx" \
ADMIN_KEY="mySecretKey" \
node server/index.js
```

### Changing the rule

Edit `server/ruleEvaluator.js` — only the `conformsToRule(a, b, c)` function:

```js
// Any strictly ascending sequence (default)
function conformsToRule(a, b, c) {
  return b > a && c > b;
}

// Example: multiples of 3
function conformsToRule(a, b, c) {
  return [a, b, c].every(n => n % 3 === 0);
}
```

The rule label in `RULE_LABEL` is for researcher logs only — participants never see it.

### Changing group size or round cap

Edit `server/groupManager.js`:
```js
const GROUP_SIZE = 3;    // participants per group
const MAX_ROUNDS = 20;   // hard cap on trial rounds
```

---

## Qualtrics Integration

### Step 1: End of pre-task survey block

Add a redirect at the end of your Qualtrics instructions block. Use a
Web Service element or an End of Survey element with a custom redirect URL:

```
https://yourdomain.com/?rid=${e://Field/ResponseID}
```

The `rid` parameter carries Qualtrics's response ID into the task app, enabling
data linkage after the session.

### Step 2: Return URL

Set `QUALTRICS_RETURN_URL` to your Qualtrics survey link. After task completion,
participants are automatically redirected to:

```
https://youruni.qualtrics.com/jfe/form/SV_xxxxxxxx?task_complete=1&participant_label=Participant+A&total_trials=7&rule_stated=ascending+numbers&rule_correct_flag=1&group_id=...
```

You can capture these as Qualtrics embedded data using the survey flow.

### Step 3: Capture return parameters in Qualtrics

In your Qualtrics Survey Flow, add a **Set Embedded Data** element at the top
and capture the URL parameters:

| Embedded Data Name   | Value                          |
|----------------------|--------------------------------|
| `task_complete`      | `${q://URL/task_complete}`     |
| `participant_label`  | `${q://URL/participant_label}` |
| `total_trials`       | `${q://URL/total_trials}`      |
| `rule_stated`        | `${q://URL/rule_stated}`       |
| `rule_correct_flag`  | `${q://URL/rule_correct_flag}` |
| `group_id`           | `${q://URL/group_id}`          |

---

## Session Data

Full session records (chat logs, all trials, timestamps) are written to
`logs/sessions_YYYY-MM-DD.ndjson` — one JSON record per completed session,
one file per day.

To download today's sessions:
```
GET /admin/sessions?key=yourAdminKey
```

Returns a JSON array of session objects. Merge with Qualtrics data using
`qualtricsRid` (from the task) matched against Qualtrics's `ResponseID`.

### Session record structure

```json
{
  "groupId": "uuid",
  "createdAt": 1234567890,
  "completedAt": 1234567890,
  "status": "complete",
  "participants": [
    { "label": "Participant A", "qualtricsRid": "R_abc123", ... }
  ],
  "totalTrials": 7,
  "trials": [
    { "round": 1, "triple": { "a": 2, "b": 4, "c": 8 }, "verdict": "Yes", "conforms": true }
  ],
  "ruleAnnouncement": {
    "statedRule": "any ascending sequence",
    "assessment": { "flagged": false, "note": "Likely correct..." },
    "round": 7
  },
  "chatLog": [
    { "round": 1, "label": "Participant A", "message": "Let's try 2, 4, 8", "timestamp": ... }
  ]
}
```

---

## Deployment

Any Node.js host works. Recommended options for research use:

- **Railway** or **Render** — simple git-push deployment, free tier available
- **DigitalOcean App Platform** — straightforward, $5/month
- **Your institution's server** — if you need data to stay on-premises

For production, add a reverse proxy (nginx) and TLS (Let's Encrypt).

---

## File Structure

```
246task/
├── server/
│   ├── index.js          # Express + Socket.io server
│   ├── groupManager.js   # Matching, state, session export
│   ├── ruleEvaluator.js  # THE RULE — edit this to change conditions
│   └── logger.js         # Session log writer
├── public/
│   ├── index.html        # Single-page entry point
│   ├── css/style.css     # All styles
│   └── js/client.js      # All client-side socket + UI logic
├── logs/                 # Created automatically on first session
├── package.json
└── README.md
```
