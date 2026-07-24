# ClickUp Time Track — Enhancement Plan

## Context & architecture

- **The app** (`index.html` + `app.js` + `style.css`) is a 100% static, browser-only page. Each
  user pastes their own ClickUp **personal API token**, which is stored only in their browser
  (`sessionStorage`) and sent directly to `https://api.clickup.com`. No backend, no shared server.
- **The ClickUp MCP** (authorized via `/mcp`) is a tool available to Claude *in the editor only*.
  It is **not** part of the deployed app and cannot be. Its role here is to let Claude query the
  real MediaPlus Digital workspace to validate data shapes before writing app code. All app
  features are implemented against the ClickUp **REST API v2**, the same API the app already uses.

## Hosting for the team (Vercel)

The app is inherently multi-user and safe to host publicly:

- Static deploy — Vercel serves it with no server or database.
- Each teammate uses **their own** token; nobody's token touches a server or another browser.
- Data is private per user — every fetch filters by `assignee = <that user's id>`.
- No secrets in the repo (the token is user-supplied), so it's safe on GitHub.
- Rate limits are per-token, so one heavy user can't throttle others.

**Confirmed from live data:** MediaPlus Digital is the workspace (team id `3300027`); its spaces
(Project Delivery, Web Maintenance, etc.) live inside it. Because it's the workspace, the old
`teams[0]` code already resolved to it — the picker (Phase 0) matters for teammates who *also*
belong to other ClickUp workspaces.

### Pre-launch checklist
1. **Workspace picker** — done in Phase 0 (defaults to MediaPlus Digital).
2. **CORS** — the app already calls ClickUp from the browser and works. Re-confirm from the
   `*.vercel.app` domain after first deploy. If it ever breaks, add a tiny Vercel serverless
   proxy (`/api/clickup/*`) — no app-logic change.
3. **Onboarding** — the token help text ("Settings → Apps → API Token") is already in the UI.

---

## Phase 0 — Team-ready ✅ (implemented)
- Workspace dropdown populated from `/team`, defaulting to the one matching `/mediaplus/i`,
  else the first workspace. Switching updates the active workspace without reconnecting.

## Phase 1 — Detect forgotten tasks ✅ (implemented)
Turns the blunt "Missing X hrs" number into an actual list of untracked tasks.

- New **Untracked Tasks** card (step 04). On fetch, after loading time entries, the app calls
  `GET /team/{teamId}/task` filtered by `assignees[]=<me>` and `due_date_gt/lt` = the selected
  range (`include_closed=true`, paginated).
- **Untracked = assigned task, DUE within the range, with zero time entries** (joined on task id).
- Sorted due-dated first (earliest due), then by name. Each row shows project code, status, due
  date, and an "Open" link to the task in ClickUp.

### Why scope by due date (evolved from live data)
- First cut used `date_updated_gt/lt` (tasks *touched* in the range), but that surfaced out-of-period
  tasks — e.g. a task due in December that merely got a comment this week.
- Switched to `due_date_gt/lt`: only tasks that **belonged to the selected window** (were due then)
  appear. This is the literal "within the selected time" the user wanted, and it cuts the noise.
- Statuses are heavily customized per space (`hq`, `daily`, `on leave`, …), so generic status names
  can't decide "should have been tracked" — due date is the reliable period boundary.
- **No-due-date tasks are also included** via a second query: ClickUp's due-date filter drops tasks
  with no due date, so `fetchInRange` runs a `due_date_gt/lt` query PLUS a `date_updated_gt/lt` query
  kept to `!due_date` tasks, then merges/dedupes. So a forgotten task with no due date still surfaces
  if it was active in the window. (Trade-off: reintroduces some no-due recurring-item noise.)

### Known limitations / tuning fast-follows
- No-due-date tasks are scoped only by "updated in range" (no due date to bound them) — can be noisier.
- A task worked-and-completed with time logged elsewhere is correctly treated as tracked.

## Phase 2 — Log time from the app (make it read-write) ✅ (implemented)
The app was GET-only; it can now write, closing the loop where you find the gap.
- Added `cuPost` + `addTimeEntry` → `POST /team/{teamId}/time_entries` with
  `{ tid, start, duration, billable }` (assignee omitted → attributed to the token owner).
- Each untracked row has an inline **Add time** action: enter hours + date → **Log**. On success
  the app re-runs the fetch so totals update and the now-tracked row disappears.
- Date defaults to the selected range's end so the logged entry falls in-range and the row clears.

### Still optional (not built)
- Start/stop a live timer; edit or delete existing entries.
- The write path hasn't been exercised against live ClickUp yet — verify one entry before relying on it.

## Phase 2.5 — Deep scan for handed-off tasks ✅ (implemented)
Catches the gap Phase 1 can't: tasks you worked but **reassigned away** (no longer your assignee).

- **Why it's needed:** ClickUp's public API has no task activity/assignee-history endpoint (that lives
  only in the web UI). But being assigned auto-adds you as a **watcher**, and that persists after
  reassignment — so "am I a watcher/creator" is the API-readable proxy for "was this ever mine."
- **How it works (on-demand, step 05 card):** fetch all tasks in your spaces **due within the range**
  (`GET /team/{teamId}/task?space_ids[]=…&due_date_gt/lt`), drop ones you're assigned to or have
  logged time on, then per-task `GET /task/{id}` to check watcher/creator. Flagged tasks show with the
  current assignee ("Now: …") and the same inline **Add time**.
- **Cost controls:** per-task checks run in a concurrency pool of 4, capped at 150/scan, with 429
  backoff and a coverage line ("checked N of M — narrow the range for full coverage"). Auto fast-path
  if the bulk list ever returns watchers. The date range is the throttle.
- **Limits:** the cap can under-cover very large spaces — surfaced in the stats line, not hidden.

### ⚠ The watcher signal is BROKEN — do not trust this scan as shipped
Gibson **authored the ClickUp task templates**, and his name was on them as a watcher. Every time a PM
**copies a template**, that watcher is carried onto the new task. So he is a watcher on a large number
of tasks he never touched, and the scan produces heavy false positives.

Corroborated in the data: task activity reads *"Shawn Lam created this task by copying #86eqkrjkh"*,
and Project Delivery contains the same template task set ("Create Staging", "Final Check +
Desktop>Tablet>Mobile Responsive", "Go Live", "eCommerce Set Up") repeated across many client lists.

**Deep scan v2 (designed, NOT yet built)** — replace the signal:
1. Server-side filter on the **Team** custom field (workspace-level, so one query covers everything):
   `custom_fields=[{"field_id":"41dbfbd6-a356-4962-9e3c-0cbf32e87b84","operator":"=","value":"<option id>"}]`.
   Team 3 = `5267f726-21d1-4f7d-a498-59eb18a32fb7`. Offer a Team dropdown so teammates pick their own.
2. Drop tasks assigned to the user and tasks they already logged time on.
3. On the (now small) remainder, check **comments authored by the user**
   (`GET /task/{id}/comment` → `user.id`) — templates don't copy comments, and Gibson comments on
   handoff ("@X This task is done. Kindly Review."). That's the genuine fingerprint.
4. Because step 1 shrinks the pool hard, the 150 cap / pool / coverage warnings can likely be dropped.

Rejected signals: **watcher** (template inheritance, above); **Project Owner** custom field (defined
but the team isn't filling it in yet); **creator** (the PM becomes creator when copying, so it only
catches self-created tasks — possible weak secondary).

## Phase 3 — Polish — *later*
- Persist selected workspace + last date range.
- Fold the untracked count into the summary grid.
- Loading/empty/error states for the new calls (basic states already added).

---

# Workspace context & constraints

How MediaPlus uses ClickUp is **deliberate** and shaped by real constraints. Build the app around this
workflow; don't treat these as anti-patterns to fix.

1. **No ClickUp Business plan** → the native `billable` flag on time entries is **unavailable**. All
   entries read `billable: false` because the feature is inaccessible, not unused. Do not propose
   billable-based solutions.
2. **HQ Timesheet space** (month lists: Daily Stand Up, Weekly Meeting, On Leave) = **admin /
   non-project time only**, deliberately separate from project time. Only internal codes
   **0000–0004** are in active reuse; everything older is prior-year history.
3. **Per-client "Time Tracking" lists** (~9) exist because **web maintenance is retainer-based**:
   hours draw down a fixed man-hour package the client bought, and work outside the package must be
   tracked separately so it doesn't consume package hours. With no `billable` flag available, a
   separate catch-all task is the only way to segregate this — it is the correct solution, not a
   workaround.
4. **Audit retention** — historical tasks, lists and time entries are kept for audit. **Never delete
   anything**, and never build a delete path. The app is deliberately **read + append-only**: it reads
   data and creates time entries; it never edits or removes existing ones. Old lists should be
   *filtered out of views*, never cleaned up.

### ⚠ Consequence for detection (open bug)
Because maintenance hours live on the client's catch-all task, a **maintenance ticket with zero time
logged is normal, not forgotten**. As shipped, the Untracked card and Deep Scan raise false positives
across all maintenance work. Must be fixed — see open decisions.

# ClickUp API capability findings (verified live)

| Data | Readable via public API? | Notes |
|---|---|---|
| Time entries | ✅ | `GET /team/{id}/time_entries`, filter by assignee + date range |
| Tasks by assignee | ✅ | `assignees[]`, `due_date_gt/lt`, `date_updated_gt/lt`, `space_ids[]` |
| Watchers / creator | ✅ | Only on single `GET /task/{id}` — **not** in bulk list responses |
| Comments (+ author id) | ✅ | `GET /task/{id}/comment` → `user.id`, per task |
| Custom fields (Team, Project Owner) | ✅ | Workspace-level; **server-side filterable** via `custom_fields` param |
| Status durations | ✅ | `time_in_status` |
| **Task activity / assignee history** | ❌ | Only in the ClickUp web UI (private endpoints). Cannot read "was assigned to me, then reassigned" |
| **Automations** | ❌ | No public endpoint. Only their *effects* are visible (e.g. ClickBot setting `Team`) |

**Custom field IDs** — `Team` = `41dbfbd6-a356-4962-9e3c-0cbf32e87b84` (labels): Web Maint, Team 1,
Team 2, **Team 3 = `5267f726-21d1-4f7d-a498-59eb18a32fb7`**, Team 4, Creative, T & T.
`Project Owner` = `8ff45c3e-b2e0-447d-80dd-6d7ad4600b37` (labels; not yet populated by the team).

Other IDs: workspace/team `3300027` (MediaPlus Digital), Gibson `43791299`.

# Open decisions — resume here
1. **Maintenance tickets** — exclude from detection entirely, or show as a separate labelled group
   ("time may be on the client's package tracker")?
2. **Deep scan v2** — build the Team-filter + own-comments design above to replace the broken watcher
   signal?
3. Exclude the HQ Timesheet space and per-client "Time Tracking" lists from detection (they are the
   *destination* of time, so never "forgotten").

# Also outstanding
- **Live verification still pending** for the write path (Add time) and the deep scan — built to API
  spec but not yet exercised against real ClickUp.
- **Security:** client credentials (Shopify / Shopee / Lazada logins) are sitting in plaintext in task
  descriptions, e.g. task `86exyez51`. A `Credentials` text custom field also exists at space level.
  Recommend moving these to a password manager.

# Rough effort
| Phase | Scope | Effort |
|-------|-------|--------|
| 0 | Workspace-ready | ~half day ✅ |
| 1 | Forgot-to-track detection | ~1 day ✅ |
| 2 | Log time from app | ~1 day ✅ |
| 2.5 | Deep scan (watcher — signal broken, needs v2) | ~1 day ⚠ |
| 3 | Polish | ~half day |
