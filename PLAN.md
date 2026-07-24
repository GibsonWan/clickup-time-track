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
  `GET /team/{teamId}/task` filtered by `assignees[]=<me>` and `date_updated_gt/lt` = the selected
  range (`include_closed=true`, paginated).
- **Untracked = assigned task, active in the range, with zero time entries** (joined on task id).
- Sorted due-dated first (earliest due), then by name. Each row shows project code, status, due
  date, and an "Open" link to the task in ClickUp.
- A "Only show tasks with a due date" toggle cuts noise to the highest-signal items.

### Why "updated within the range" (learned from live data)
- Statuses are heavily customized per space (`hq`, `daily`, `weekly`, `on leave`, `deactive`, …),
  so generic status names can't decide "should have been tracked."
- The workspace has many recurring admin items (Daily Stand Up, Weekly Meeting, On Leave).
- Scoping to tasks **touched in the period** captures "worked on but not logged" while excluding
  untouched backlog and future items.

### Known v1 limitations / tuning fast-follows
- Recurring/leave items with no time still appear as noise — could add a name/status exclude list.
- Tasks with no due date can't be prioritized by urgency (only by name).
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
- **How it works (on-demand, step 05 card):** fetch all tasks in your spaces updated in the range
  (`GET /team/{teamId}/task?space_ids[]=…&date_updated_gt/lt`), drop ones you're assigned to or have
  logged time on, then per-task `GET /task/{id}` to check watcher/creator. Flagged tasks show with the
  current assignee ("Now: …") and the same inline **Add time**.
- **Cost controls:** per-task checks run in a concurrency pool of 4, capped at 150/scan, with 429
  backoff and a coverage line ("checked N of M — narrow the range for full coverage"). Auto fast-path
  if the bulk list ever returns watchers. The date range is the throttle.
- **Limits:** watcher is noisier than assignment (you're auto-added when @mentioned); the cap can
  under-cover very large spaces — surfaced honestly in the stats line, not hidden.

## Phase 3 — Polish — *later*
- Persist selected workspace + last date range.
- Fold the untracked count into the summary grid.
- Loading/empty/error states for the new calls (basic states already added).

## Rough effort
| Phase | Scope | Effort |
|-------|-------|--------|
| 0 | Workspace-ready | ~half day ✅ |
| 1 | Forgot-to-track detection | ~1 day ✅ |
| 2 | Log time from app | ~1 day ✅ |
| 3 | Polish | ~half day |
