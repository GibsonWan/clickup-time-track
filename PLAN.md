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

## Phase 2.5 — Deep scan for handed-off tasks ⚠ (shipped, signal broken — being replaced)
Catches the gap Phase 1 can't: tasks you worked but **reassigned away** (no longer your assignee).

- **Why the gap exists:** ClickUp's public API has no task activity/assignee-history endpoint (that
  lives only in the web UI). `assignees` is current-state only — it forgets. So there is no API-native
  way to recover "this was once mine."
- **As shipped:** fetch all tasks in your spaces due within the range, drop ones you're assigned to or
  have logged time on, then per-task `GET /task/{id}` to check watcher/creator. Concurrency pool of 4,
  capped at 150/scan, 429 backoff, coverage line.

### ⚠ The watcher signal is BROKEN — do not trust this scan as shipped
Gibson **authored the ClickUp task templates**, and his name was on them as a watcher. Every time a PM
**copies a template**, that watcher is carried onto the new task. So he is a watcher on a large number
of tasks he never touched, and the scan produces heavy false positives.

Corroborated in the data: task activity reads *"Shawn Lam created this task by copying #86eqkrjkh"*,
and Project Delivery contains the same template task set ("Create Staging", "Final Check +
Desktop>Tablet>Mobile Responsive", "Go Live", "eCommerce Set Up") repeated across many client lists.

## Phase 2.6 — Replace the deep scan with the `Developer(s)` field ✅ (implemented 2026-08-28)

Gibson repurposed the old `Project Owner` custom field into **`Developer(s)`** (same field id, renamed,
given a 12-person developer roster) and is rolling it out to the team. Every developer who works a task
adds themselves; entries are **never removed**, so the field accumulates everyone who ever touched it.

This is the right shape for the problem: it is a **human-maintained substitute for the missing
assignee-history API**. Rather than inferring past involvement from a noisy proxy, the team records it
deliberately.

**Field:** `Developer(s)` = `8ff45c3e-b2e0-447d-80dd-6d7ad4600b37`, type `labels`.
Options: Gibson `acf04f01-775e-4ef4-bcee-1f7c44bcda60`, Victor `7557bc08-5b2b-4490-b4df-8c0a9781e3b1`,
Jonathon `53b6a888-68ac-405b-a11c-33388673da4b`, Zhen Yang `7232bc01-100a-49a1-995a-e26098e9b579`,
Marlvin `c3fb6c0c-bf8c-4902-8445-29bc0e1e9d3b`, Amie `5bab7a33-b2fe-42cf-9625-fd6e84dc05b5`,
Wen `e133335f-fe81-4ade-8761-b2d3b815c6b7`, Shafeeq `1f75060b-2aaa-4f49-ab41-60464c68f68c`,
Travis `fa24511a-9507-498b-9fd1-4894e41c06e0`, Tasha `d040312d-6c24-4255-97b9-7ef9abc124af`,
Tino `41f60799-bf26-4b57-8391-94920e5a75bb`, Aiman `c9bd40c7-793d-4c0f-b18c-a835da8420bd`.

Verified populated in live data (task `86eyprna3` → `Developer(s): [Gibson]`, `Team: [Team 3]`).

**Design:**
1. Server-side filter on the field, workspace-wide in one query — no space enumeration:
   `custom_fields=[{"field_id":"8ff45c3e-b2e0-447d-80dd-6d7ad4600b37","operator":"ANY","value":["<option id>"]}]`
2. Drop tasks the user is assigned to (Phase 1 already covers those) and tasks they logged time on.
3. What remains = worked-but-untracked. No per-task fetch, so the **150 cap, concurrency pool, 429
   backoff and coverage warning can all be deleted.**

**Keep assignee detection as the baseline — do NOT make this a straight swap.**
Watcher was noisy but *automatic*; `Developer(s)` is accurate but *depends on people filling it in*.
That flips the failure mode from false positives to **false negatives**, which are worse here: a
developer having a scattered week forgets to tag themselves on exactly the week they also forget to log
time — the signal goes quiet when it's needed most. Phase 1 (assignee) stays the automatic floor;
`Developer(s)` is an **additive** second source. Union the two, never replace.

**Design constraints to honour:**
- **No timestamp.** The field says *who*, not *when*. The app's question is "in this range, did I work
  something unlogged?" — so the existing `due_date` / `date_updated` range-bounding from Phase 1 still
  applies on top of the field filter.
- **Cutover date.** Tasks before rollout have an empty field, so a scan over an earlier range returns
  nothing and *looks clean* — a silent wrong answer. Hardcode the rollout date; for ranges before it,
  fall back to assignee-only and say so in the UI ("Developer(s) tracking starts <date>").
- **Label → user identity.** Options are first names (`Gibson`), the API returns users (`Gibson Wan`).
  Solved with a picker: the app guesses by name, the user can correct it, and the choice is remembered
  in `localStorage`. Guessing only accepts an unambiguous single match, so shared first names fall
  through to a manual pick rather than silently attributing to the wrong person.
- **Not enforced.** Append-only is a team convention, not a ClickUp constraint — the field can be
  edited or cleared. Accept this; don't build around it.

Rejected signals: **watcher** (template inheritance, above); **creator** (the PM becomes creator when
copying, so it only catches self-created tasks); **Team custom field** (correct but too coarse — it
identifies the team, not the person).

### As built
- Step 05 is now **"Worked but Not Assigned"** (`developerScan`), replacing the watcher deep scan.
  `fetchSpaces`, `fetchSpaceTasks`, `checkInvolvement`, `getTaskWithRetry`, `isMine`, the 150 cap and
  the concurrency pool are all deleted — the field filters server-side, so it's two list calls
  (due-in-range + no-due-date-but-active) with no per-task lookups.
- The roster is fetched from `GET /team/{teamId}/field` at connect time so a developer added in ClickUp
  shows up without a code change; if that endpoint isn't available it falls back to the roster hardcoded
  in `app.js` (`DEV_OPTIONS_FALLBACK`, verified live 2026-08-28).
- Cutover is `DEV_FIELD_START = '2026-09-01'` in `app.js`. Ranges starting earlier still run, but the
  card shows a warning that the field was not yet in use — so an empty result never reads as "all clear".
- **Still not verified against live ClickUp**: the `custom_fields` filter parameter is built to API spec
  and unit-tested locally, but no real scan has been run. Verify with one September range before relying
  on it. Same outstanding caveat as the write path.

### Token persistence (shipped alongside)
The token moved from `sessionStorage` to `localStorage`, so it survives closing the tab — the team pastes
it once per machine instead of every session — and the app auto-connects on load. A saved token that
fails auth is dropped rather than leaving the app stuck on a dead credential, and a **Forget saved token**
button clears both the token and the remembered developer choice for shared machines.

Deliberately *not* done: OAuth. It would remove token handling entirely, but the code-for-token exchange
needs a client secret, which a static page can't hold — so it needs a Vercel serverless function. Worth
revisiting if the team grows; `localStorage` gives the same day-to-day experience for two lines.

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
| Custom fields (Team, Developer(s)) | ✅ | Workspace-level; **server-side filterable** via `custom_fields` param |
| Status durations | ✅ | `time_in_status` |
| **Task activity / assignee history** | ❌ | Only in the ClickUp web UI (private endpoints). Cannot read "was assigned to me, then reassigned" |
| **Automations** | ❌ | No public endpoint. Only their *effects* are visible (e.g. ClickBot setting `Team`) |

**Custom field IDs** — `Team` = `41dbfbd6-a356-4962-9e3c-0cbf32e87b84` (labels): Web Maint, Team 1,
Team 2, **Team 3 = `5267f726-21d1-4f7d-a498-59eb18a32fb7`**, Team 4, Creative, T & T.
`Developer(s)` = `8ff45c3e-b2e0-447d-80dd-6d7ad4600b37` (labels) — the former `Project Owner` field,
renamed and given a developer roster; being rolled out to the team. Full option ids in Phase 2.6.

Other IDs: workspace/team `3300027` (MediaPlus Digital), Gibson `43791299`.

# Open decisions — resume here
1. **Maintenance tickets** — exclude from detection entirely, or show as a separate labelled group
   ("time may be on the client's package tracker")?
2. ~~**Deep scan v2** — Team-filter + own-comments?~~ **DONE (2026-08-28):** superseded by the
   `Developer(s)` field and implemented — see Phase 2.6. Cutover set to `2026-09-01`; change
   `DEV_FIELD_START` in `app.js` if the team starts on a different date.
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
| 2.5 | Deep scan (watcher — signal broken, superseded) | ~1 day ⚠ |
| 2.6 | Replace deep scan with `Developer(s)` filter | ~half day ✅ |
| 3 | Polish | ~half day |
