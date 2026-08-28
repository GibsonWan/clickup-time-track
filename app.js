const API = 'https://api.clickup.com/api/v2';

const TOKEN_KEY = 'cu_token';
const DEV_KEY   = 'cu_developer_option'; // which Developer(s) label is "me"
const CODE_KEY    = 'cu_code_overrides'; // task id -> hand-entered project code
const DISMISS_KEY = 'cu_dismissed';      // task ids hidden from the two task lists

// ---------- Manual project codes ----------
// Some tasks carry no code anywhere — not in the list name, not in the title. Rather
// than export a blank column, the user types the code once and we remember it here.
// Kept local on purpose: the app is read + append-only against ClickUp and must never
// edit existing task data, so an override lives in the browser, not in the workspace.
function loadCodeOverrides() {
  try { return JSON.parse(localStorage.getItem(CODE_KEY)) || {}; } catch (_) { return {}; }
}

function saveCodeOverride(taskId, code) {
  if (!taskId) return;
  const all = loadCodeOverrides();
  if (code) all[taskId] = code; else delete all[taskId];
  try { localStorage.setItem(CODE_KEY, JSON.stringify(all)); } catch (_) {}
  state.codeOverrides = all;
}

// ---------- Dismissed tasks ----------
// Not every flagged task is real work that went untracked — some are stale, cancelled,
// or tracked on the client's retainer task instead. Dismissing one hides it from both
// lists for good. Local-only, like code overrides: the app never edits ClickUp data.
function loadDismissed() {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY)) || []); }
  catch (_) { return new Set(); }
}

function persistDismissed() {
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...state.dismissed])); } catch (_) {}
}

function dismissTask(taskId) {
  if (!taskId) return;
  state.dismissed.add(taskId);
  persistDismissed();
}

// Restoring re-runs the fetch: a dismissed task's row was dropped from state, so the
// only way to bring it back is to ask ClickUp for it again.
async function restoreAllDismissed() {
  state.dismissed.clear();
  persistDismissed();
  renderUntracked();
  if (state.deepscanStats) renderDeepScan(state.deepscan, state.deepscanStats);
  showStatus('Restored dismissed tasks — refreshing...', 'loading');
  if (state.token && state.entries.length >= 0) await handleFetch();
  showStatus('Restored all dismissed tasks.', 'success');
  setTimeout(hideStatus, 3000);
}

// Shown under either list so dismissing is never a one-way door.
function dismissedFooterHTML() {
  const n = state.dismissed.size;
  if (!n) return '';
  return `<div class="dismissed-note">${n} task${n !== 1 ? 's' : ''} dismissed ·
    <button type="button" class="link-btn" data-restore-all>Restore all</button></div>`;
}

// ---------- Developer(s) custom field ----------
// Workspace-level labels field (formerly "Project Owner"). Developers add themselves
// to every task they work and are never removed, so it accumulates everyone who ever
// touched the task — the human-maintained stand-in for the assignee history the
// ClickUp public API doesn't expose.
const DEV_FIELD_ID = '8ff45c3e-b2e0-447d-80dd-6d7ad4600b37';

// Fallback roster, verified live 2026-08-28. Refreshed from the API at connect time
// when possible, so adding a developer in ClickUp doesn't require a code change.
const DEV_OPTIONS_FALLBACK = [
  { id: 'acf04f01-775e-4ef4-bcee-1f7c44bcda60', label: 'Gibson' },
  { id: '7557bc08-5b2b-4490-b4df-8c0a9781e3b1', label: 'Victor' },
  { id: '53b6a888-68ac-405b-a11c-33388673da4b', label: 'Jonathon' },
  { id: '7232bc01-100a-49a1-995a-e26098e9b579', label: 'Zhen Yang' },
  { id: 'c3fb6c0c-bf8c-4902-8445-29bc0e1e9d3b', label: 'Marlvin' },
  { id: '5bab7a33-b2fe-42cf-9625-fd6e84dc05b5', label: 'Amie' },
  { id: 'e133335f-fe81-4ade-8761-b2d3b815c6b7', label: 'Wen' },
  { id: '1f75060b-2aaa-4f49-ab41-60464c68f68c', label: 'Shafeeq' },
  { id: 'fa24511a-9507-498b-9fd1-4894e41c06e0', label: 'Travis' },
  { id: 'd040312d-6c24-4255-97b9-7ef9abc124af', label: 'Tasha' },
  { id: '41f60799-bf26-4b57-8391-94920e5a75bb', label: 'Tino' },
  { id: 'c9bd40c7-793d-4c0f-b18c-a835da8420bd', label: 'Aiman' },
];

// Earliest date the Developer(s) field can be trusted to be filled in. Before it the
// field is mostly empty, so a scan would come back clean and *look* fine — a silent
// wrong answer — hence the warning on earlier ranges.
//
// Gibson was already tagging tasks through August 2026 ahead of the team-wide rollout
// in September, so August is genuine data and shouldn't warn. Move this back further
// if it turns out the field was in use earlier than that.
const DEV_FIELD_START = '2026-08-01';

// ---------- State ----------
let state = {
  token: '',
  user: null,
  teams: [],
  teamId: null,
  entries: [],
  untracked: [],
  deepscan: [],
  devOptions: DEV_OPTIONS_FALLBACK,
  devOptionId: null, // the option representing the logged-in user
  codeOverrides: {},
  dismissed: new Set(),
  deepscanStats: null,
};

// ---------- DOM refs ----------
const $token       = document.getElementById('api-token');
const $btnConnect  = document.getElementById('btn-connect');
const $userInfo    = document.getElementById('user-info');
const $wsWrap      = document.getElementById('workspace-wrap');
const $wsSelect    = document.getElementById('workspace-select');
const $secDates    = document.getElementById('section-dates');
const $secExport   = document.getElementById('section-export');
const $secUntracked = document.getElementById('section-untracked');
const $dateFrom    = document.getElementById('date-from');
const $dateTo      = document.getElementById('date-to');
const $btnFetch    = document.getElementById('btn-fetch');
const $tableBody   = document.getElementById('table-body');
const $summary     = document.getElementById('summary');
const $rowCount    = document.getElementById('row-count');
const $btnExport   = document.getElementById('btn-export');
const $btnCopy     = document.getElementById('btn-copy');
const $statusBar   = document.getElementById('status-bar');
const $untrackedList  = document.getElementById('untracked-list');
const $untrackedCount = document.getElementById('untracked-count');
const $secDeepscan    = document.getElementById('section-deepscan');
const $btnDeepscan    = document.getElementById('btn-deepscan');
const $deepscanList   = document.getElementById('deepscan-list');
const $deepscanCount  = document.getElementById('deepscan-count');
const $devWrap        = document.getElementById('developer-wrap');
const $devSelect      = document.getElementById('developer-select');
const $btnForget      = document.getElementById('btn-forget');

// ---------- Init ----------
(function init() {
  // The token field is type="text" masked with -webkit-text-security so Chrome doesn't
  // treat it as a login and prompt to save it. If a browser can't mask it that way,
  // fall back to a real password field — a visible token is the worse trade.
  const canMask = window.CSS && CSS.supports &&
    (CSS.supports('-webkit-text-security', 'disc') || CSS.supports('text-security', 'disc'));
  if (!canMask) $token.type = 'password';

  state.codeOverrides = loadCodeOverrides();
  state.dismissed     = loadDismissed();
  setDefaultDates();
  bindEvents();

  // The token persists across browser sessions, so the team pastes it once per machine
  // instead of every time they open the app. Auto-connect straight through to the dates.
  const saved = localStorage.getItem(TOKEN_KEY);
  if (saved) {
    $token.value = saved;
    handleConnect({ silent: true });
  }
})();

function setDefaultDates() {
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDay  = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  $dateFrom.value = fmt(firstDay);
  $dateTo.value   = fmt(lastDay);
}

// Format as YYYY-MM-DD in LOCAL time. toISOString() would convert to UTC first, and
// east of Greenwich local midnight is the previous day in UTC — so at UTC+8 a range
// meant as 1–31 Aug came out as 31 Jul – 30 Aug, silently dropping the 31st.
function fmt(d) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// ---------- Events ----------
function bindEvents() {
  $btnConnect.addEventListener('click', () => handleConnect());
  $token.addEventListener('keydown', e => { if (e.key === 'Enter') handleConnect(); });
  $btnForget.addEventListener('click', handleForget);
  $devSelect.addEventListener('change', handleDeveloperChange);

  $btnFetch.addEventListener('click', handleFetch);

  document.querySelectorAll('[data-range]').forEach(btn => {
    btn.addEventListener('click', () => applyQuickRange(btn.dataset.range));
  });

  $dateFrom.addEventListener('change', validateDates);
  $dateTo.addEventListener('change', validateDates);

  $btnExport.addEventListener('click', exportCSV);
  $btnCopy.addEventListener('click', copyTable);

  $wsSelect.addEventListener('change', () => { state.teamId = $wsSelect.value; });
  $untrackedList.addEventListener('click', onUntrackedClick);
  $tableBody.addEventListener('click', onTableClick);
  $btnDeepscan.addEventListener('click', developerScan);
  $deepscanList.addEventListener('click', onUntrackedClick);
}

function applyQuickRange(range) {
  const now = new Date();
  let from, to;
  if (range === 'this-month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
    to   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  } else if (range === 'last-month') {
    from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    to   = new Date(now.getFullYear(), now.getMonth(), 0);
  } else if (range === 'this-week') {
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((day + 6) % 7));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    from = monday;
    to   = sunday;
  }
  $dateFrom.value = fmt(from);
  $dateTo.value   = fmt(to);
  validateDates();
}

function validateDates() {
  $btnFetch.disabled = !($dateFrom.value && $dateTo.value && $dateFrom.value <= $dateTo.value);
}

// ---------- Connect ----------
async function handleConnect(opts = {}) {
  const token = $token.value.trim();
  if (!token) { showStatus('Paste your ClickUp API token first.', 'error'); return; }

  showStatus(opts.silent ? 'Reconnecting...' : 'Connecting...', 'loading');
  $btnConnect.disabled = true;

  try {
    const user = await cuGet('/user', token);
    const teams = await cuGet('/team', token);

    if (!teams.teams || teams.teams.length === 0) {
      throw new Error('No workspaces found for this token.');
    }

    state.token = token;
    state.user  = user.user;
    state.teams = teams.teams;

    // Default to MediaPlus Digital if present, otherwise the first workspace.
    const preferred = state.teams.find(t => /mediaplus/i.test(t.name || '')) || state.teams[0];
    state.teamId = preferred.id;

    localStorage.setItem(TOKEN_KEY, token);

    renderUserInfo(state.user);
    renderWorkspaces(state.teams, state.teamId);
    await setupDeveloperPicker();
    $btnForget.classList.remove('hidden');
    $secDates.classList.remove('disabled');
    validateDates();
    hideStatus();
    showStatus('Connected as ' + state.user.username, 'success');
    setTimeout(hideStatus, 3000);
  } catch (err) {
    // A saved token that no longer works shouldn't leave the app stuck on a dead
    // credential — drop it so the next load shows a clean connect form.
    if (opts.silent) localStorage.removeItem(TOKEN_KEY);
    showStatus(err.message || 'Connection failed. Check your token.', 'error');
  } finally {
    $btnConnect.disabled = false;
  }
}

// Clears the saved token — for shared machines, or switching accounts.
function handleForget() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(DEV_KEY);
  location.reload();
}

function renderUserInfo(user) {
  $userInfo.innerHTML = `
    <div class="avatar">
      ${user.profilePicture
        ? `<img src="${user.profilePicture}" alt="${user.username}" />`
        : user.username.charAt(0).toUpperCase()}
    </div>
    <div>
      <div class="user-name">${escHtml(user.username)}</div>
      <div class="user-email">${escHtml(user.email)}</div>
    </div>
  `;
  $userInfo.classList.remove('hidden');
}

function renderWorkspaces(teams, selectedId) {
  $wsSelect.innerHTML = teams
    .map(t => `<option value="${escHtml(t.id)}" ${t.id === selectedId ? 'selected' : ''}>${escHtml(t.name || 'Workspace ' + t.id)}</option>`)
    .join('');
  $wsWrap.classList.remove('hidden');
}

// ---------- Developer(s) identity ----------
// The field's options are first-name labels ("Gibson"); the API gives us a ClickUp
// user ("Gibson Wan"). We guess by name, then let the user correct it — a guess is a
// convenience, their explicit choice is the source of truth and is remembered.
async function setupDeveloperPicker() {
  state.devOptions = await fetchDeveloperOptions(state.teamId, state.token);

  const saved = localStorage.getItem(DEV_KEY);
  const valid = saved && state.devOptions.some(o => o.id === saved);
  state.devOptionId = valid ? saved : guessDeveloperOption(state.user, state.devOptions);

  $devSelect.innerHTML =
    `<option value="">— not in the list —</option>` +
    state.devOptions
      .map(o => `<option value="${escHtml(o.id)}" ${o.id === state.devOptionId ? 'selected' : ''}>${escHtml(o.label)}</option>`)
      .join('');
  $devWrap.classList.remove('hidden');

  if (state.devOptionId) localStorage.setItem(DEV_KEY, state.devOptionId);
}

// Match the roster label against the ClickUp username. Only accept an unambiguous
// single match — two developers sharing a first name must pick manually.
function guessDeveloperOption(user, options) {
  const username = (user.username || '').trim().toLowerCase();
  if (!username) return null;

  const hits = options.filter(o => {
    const label = o.label.trim().toLowerCase();
    return username === label || username.startsWith(label + ' ');
  });
  return hits.length === 1 ? hits[0].id : null;
}

// Prefer the live field definition so a developer added in ClickUp appears without a
// code change. The workspace-level endpoint isn't in every API version, so fall back
// to the roster baked in above rather than failing the whole connect.
async function fetchDeveloperOptions(teamId, token) {
  try {
    const data  = await cuGet(`/team/${teamId}/field`, token);
    const field = (data.fields || []).find(f => f.id === DEV_FIELD_ID);
    const opts  = field && field.type_config && field.type_config.options;
    if (opts && opts.length) {
      return opts.map(o => ({ id: o.id, label: o.label || o.name || '' }));
    }
  } catch (_) { /* endpoint unavailable — use the fallback roster */ }
  return DEV_OPTIONS_FALLBACK;
}

function handleDeveloperChange() {
  state.devOptionId = $devSelect.value || null;
  if (state.devOptionId) localStorage.setItem(DEV_KEY, state.devOptionId);
  else localStorage.removeItem(DEV_KEY);
  updateDevScanAvailability();
}

// ---------- Request throttling ----------
// ClickUp rate-limits per token (~100 requests/minute below Business Plus), so any
// per-item fetch has to be bounded. Firing a whole month of lookups at once trips the
// limit and the failures are invisible — rows just quietly lose their project code.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REQUEST_POOL = 4;

// Runs `fn` over items at most REQUEST_POOL at a time. Failures resolve to undefined
// so one bad item can't reject the batch.
async function mapPooled(items, fn, poolSize = REQUEST_POOL, onProgress) {
  // Pre-filled, not `new Array(n)` — an unassigned slot is a *hole*, and holes are
  // skipped by filter/forEach, which would silently hide failures from the caller.
  const results = new Array(items.length).fill(null);
  let idx = 0, done = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await fn(items[i], i); } catch (_) { results[i] = null; }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(poolSize, items.length) }, worker));
  return results;
}

// Retries only on 429, backing off so a burst doesn't cascade into more 429s.
async function cuGetWithRetry(path, token, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return await cuGet(path, token);
    } catch (e) {
      if (/\b429\b/.test(e.message) && i < tries - 1) { await sleep(2500 * (i + 1)); continue; }
      throw e;
    }
  }
}

// ---------- Fetch ----------
async function handleFetch() {
  if (!state.token) return;

  const startMs = new Date($dateFrom.value + 'T00:00:00').getTime();
  const endMs   = new Date($dateTo.value   + 'T23:59:59').getTime();

  showStatus('Fetching time entries...', 'loading');
  $btnFetch.disabled = true;

  try {
    const entries = await fetchAllTimeEntries(state.teamId, state.token, startMs, endMs, state.user.id);
    state.entries = entries;
    renderTable(entries);
    $secExport.classList.remove('disabled');
    $btnExport.disabled = entries.length === 0;
    $btnCopy.disabled   = entries.length === 0;

    // Phase 1: find tasks assigned to me, active in this range, with no time logged.
    await loadUntracked(startMs, endMs, entries);

    // The Developer(s) scan is available once a range is fetched (it reuses these
    // entries + dates), provided we know which roster name is this user.
    $secDeepscan.classList.remove('disabled');
    updateDevScanAvailability();

    hideStatus();

    if (entries.length === 0) {
      showStatus('No time entries found for this date range.', 'error');
      setTimeout(hideStatus, 4000);
    }
  } catch (err) {
    showStatus(err.message || 'Failed to fetch entries.', 'error');
  } finally {
    $btnFetch.disabled = false;
    validateDates();
  }
}

async function fetchAllTimeEntries(teamId, token, startMs, endMs, userId) {
  const params = new URLSearchParams({
    start_date: startMs,
    end_date:   endMs,
    assignee:   userId,
  });

  const data = await cuGet(`/team/${teamId}/time_entries?${params}`, token);
  const raw  = data.data || [];

  // Find entries where task_location gives no list name — fetch task details for those
  const missingIds = [...new Set(
    raw
      .filter(e => {
        const loc = e.task_location || e.taskLocation || {};
        return e.task?.id && !(loc.list_name || loc.listName || e.task?.list?.name);
      })
      .map(e => e.task.id)
  )];

  const taskCache = {};
  if (missingIds.length > 0) {
    showStatus(`Fetching task details (${missingIds.length} tasks)...`, 'loading');
    const fetched = await mapPooled(
      missingIds,
      id => cuGetWithRetry(`/task/${id}`, token),
      REQUEST_POOL,
      (done, total) => showStatus(`Fetching task details (${done}/${total})...`, 'loading')
    );
    fetched.forEach((t, i) => { if (t) taskCache[missingIds[i]] = t; });

    // Lookups that still failed lose their project code in the export, so say so
    // rather than letting the CSV quietly come out wrong.
    const failed = fetched.filter(t => !t).length;
    if (failed > 0) {
      showStatus(`${failed} of ${missingIds.length} task lookups failed — those rows may show "N/A" for project. Try a narrower date range.`, 'error');
      setTimeout(hideStatus, 6000);
    }
  }

  const entries = raw.map(e => parseEntry(e, taskCache));
  entries.sort((a, b) => a.sortDate.localeCompare(b.sortDate));
  return entries;
}

function parseEntry(e, taskCache = {}) {
  const taskName = e.task ? e.task.name : '(no task)';

  // Try every known field path ClickUp uses across API versions
  const loc        = e.task_location || e.taskLocation || {};
  let listName     = loc.list_name   || loc.listName   || e.task?.list?.name   || '';
  let listId       = loc.list_id     || loc.listId     || e.task?.list?.id     || '';
  let folderName   = loc.folder_name || loc.folderName || e.task?.folder?.name || '';
  let folderId     = loc.folder_id   || loc.folderId   || e.task?.folder?.id   || '';

  // Last resort: task detail fetched individually
  if (!listName && e.task?.id && taskCache[e.task.id]) {
    const t  = taskCache[e.task.id];
    listName   = t.list?.name    || '';
    listId     = t.list?.id      || '';
    folderName = t.folder?.name  || t.project?.name || '';
    folderId   = t.folder?.id    || t.project?.id   || '';
  }

  let { projectCode, projectInfo } = parseProject(listName, listId, folderId, folderName, taskName);

  // A code the user typed in beats anything we derived.
  const taskId = e.task?.id || '';
  if (state.codeOverrides[taskId]) projectCode = state.codeOverrides[taskId];

  const d        = new Date(parseInt(e.start));
  const date     = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  // Local, to match the displayed date — UTC here would sort an early-morning entry
  // under the previous day while the row still showed today's date.
  const sortDate = fmt(d);

  const durationMs = parseInt(e.duration || 0);
  const hours      = +(durationMs / 3600000).toFixed(2);

  return { date, sortDate, projectCode, projectInfo, taskName, taskId, hours, folderName, raw: e };
}

// ---------- Untracked tasks (Phase 1) ----------
async function loadUntracked(startMs, endMs, entries) {
  $secUntracked.classList.remove('disabled');

  try {
    showStatus('Checking for untracked tasks...', 'loading');
    const tasks = await fetchAssignedTasks(state.teamId, state.token, state.user.id, startMs, endMs);

    // Hours logged per task id within this range (from the entries we already have).
    const loggedByTask = {};
    entries.forEach(en => {
      const id = en.raw && en.raw.task ? en.raw.task.id : null;
      if (id) loggedByTask[id] = (loggedByTask[id] || 0) + en.hours;
    });

    // Untracked = assigned & active in range, but no time logged. De-dupe by id.
    const seen = new Set();
    const untracked = tasks.filter(t => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      if (state.dismissed.has(t.id)) return false;
      return !(loggedByTask[t.id] > 0);
    });

    // Due-dated first (earliest due first), then the rest by name.
    untracked.sort((a, b) => {
      const da = a.due_date ? parseInt(a.due_date) : Infinity;
      const db = b.due_date ? parseInt(b.due_date) : Infinity;
      if (da !== db) return da - db;
      return (a.name || '').localeCompare(b.name || '');
    });

    state.untracked = untracked;
    renderUntracked();
  } catch (err) {
    state.untracked = [];
    $untrackedCount.textContent = '';
    $untrackedList.innerHTML =
      `<div class="untracked-note">Couldn't load assigned tasks: ${escHtml(err.message || 'request failed')}</div>`;
  }
}

async function fetchAssignedTasks(teamId, token, userId, startMs, endMs) {
  const base = `assignees%5B%5D=${encodeURIComponent(userId)}&subtasks=true&include_closed=true`;
  return fetchInRange(teamId, token, base, startMs, endMs);
}

// Returns tasks either DUE within the range, OR with no due date but updated within the range.
// ClickUp's due_date filter drops no-due-date tasks, so we run two queries and merge.
async function fetchInRange(teamId, token, baseQs, startMs, endMs) {
  const dueInRange = await pagedTasks(
    teamId, token, `${baseQs}&due_date_gt=${startMs - 1}&due_date_lt=${endMs + 1}`);
  const noDueButActive = (await pagedTasks(
    teamId, token, `${baseQs}&date_updated_gt=${startMs}&date_updated_lt=${endMs}`))
    .filter(t => !t.due_date);
  return dedupeById([...dueInRange, ...noDueButActive]);
}

async function pagedTasks(teamId, token, filterQs, maxPages = 30) {
  const tasks = [];
  for (let page = 0; page < maxPages; page++) {
    const data  = await cuGet(`/team/${teamId}/task?page=${page}&${filterQs}`, token);
    const batch = data.tasks || [];
    tasks.push(...batch);
    if (batch.length < 100) break; // last page
  }
  return tasks;
}

function dedupeById(list) {
  const seen = new Set();
  return list.filter(t => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

function renderUntracked() {
  const list = state.untracked;

  $untrackedCount.textContent = list.length
    ? `${list.length} task${list.length !== 1 ? 's' : ''}`
    : 'All clear';

  if (list.length === 0) {
    $untrackedList.innerHTML =
      `<div class="untracked-empty">Every task assigned to you and active in this range has time logged. 🎉</div>`
      + dismissedFooterHTML();
    return;
  }

  const defaultDate = $dateTo.value; // within the fetched range, so the row clears after logging
  $untrackedList.innerHTML =
    list.map(t => taskItemHTML(t, defaultDate, { showAssignee: false })).join('')
    + dismissedFooterHTML();
}

// Shared markup for a task row with an inline "Add time" form. Used by both the
// assigned-untracked list and the deep-scan list.
function taskItemHTML(t, defaultDate, opts = {}) {
  const listObj  = t.list || {};
  const name     = t.name || '(untitled task)';
  const { projectCode } = parseProject(listObj.name || '', listObj.id || '', '', '', name);
  const status   = t.status && t.status.status ? t.status.status : '';
  const dueLabel = t.due_date ? fmtDue(parseInt(t.due_date)) : '';
  const url      = t.url || `https://app.clickup.com/t/${t.id}`;
  const assignees = (t.assignees || []).map(a => a.username).filter(Boolean).join(', ');

  const pills = [
    projectCode !== 'N/A' ? `<span class="u-pill">${escHtml(projectCode)}</span>` : '',
    status ? `<span class="u-pill">${escHtml(status)}</span>` : '',
    dueLabel ? `<span class="u-pill u-due">Due ${escHtml(dueLabel)}</span>` : '',
    (opts.showAssignee && assignees) ? `<span class="u-pill u-assignee">Now: ${escHtml(assignees)}</span>` : '',
  ].join('');

  return `
    <div class="untracked-item ${t.due_date ? 'is-due' : ''}" data-task-id="${escHtml(t.id)}" data-task-name="${escHtml(name)}">
      <div class="u-body">
        <div class="u-name">${escHtml(name)}</div>
        <div class="u-meta">${pills}</div>
        <div class="u-form">
          <input type="number" class="input u-hours" min="0" step="1" placeholder="Hrs" aria-label="Hours" />
          <input type="number" class="input u-mins" min="0" max="59" step="5" placeholder="Min" aria-label="Minutes" />
          <input type="date" class="input u-date" value="${escHtml(defaultDate)}" aria-label="Date" />
          <button class="btn btn-success u-save" type="button">Log</button>
          <button class="btn u-cancel" type="button">Cancel</button>
        </div>
      </div>
      <div class="u-actions">
        <button class="btn u-add" type="button">Add time</button>
        <a class="u-open" href="${escHtml(url)}" target="_blank" rel="noopener">
          Open
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M7 7h10v10"/></svg>
        </a>
      </div>
      <button class="u-dismiss" type="button" title="Not relevant — hide this task" aria-label="Dismiss task">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}

// Inline "Add time" handling (event-delegated on the untracked list).
async function onUntrackedClick(e) {
  if (e.target.closest('[data-restore-all]')) { restoreAllDismissed(); return; }

  const item = e.target.closest('.untracked-item');
  if (!item) return;

  if (e.target.closest('.u-dismiss')) {
    const id   = item.dataset.taskId;
    const name = item.dataset.taskName || 'task';
    dismissTask(id);
    state.untracked = state.untracked.filter(t => t.id !== id);
    state.deepscan  = state.deepscan.filter(t => t.id !== id);
    // Re-render both so the "N dismissed · Restore all" line stays accurate in each.
    // Only touch the scan list if a scan has actually run, or we'd render its results
    // panel over an untouched card.
    renderUntracked();
    if (state.deepscanStats) renderDeepScan(state.deepscan, state.deepscanStats);
    showStatus(`Dismissed "${name}".`, 'success');
    setTimeout(hideStatus, 3000);
    return;
  }

  if (e.target.closest('.u-add')) {
    item.classList.add('editing');
    const h = item.querySelector('.u-hours');
    if (h) h.focus();
    return;
  }

  if (e.target.closest('.u-cancel')) {
    item.classList.remove('editing');
    return;
  }

  const saveBtn = e.target.closest('.u-save');
  if (!saveBtn) return;

  const taskId  = item.dataset.taskId;
  const name    = item.dataset.taskName || 'task';
  const hrs     = parseFloat(item.querySelector('.u-hours').value) || 0;
  const mins    = parseFloat(item.querySelector('.u-mins').value)  || 0;
  const dateStr = item.querySelector('.u-date').value;

  // Either box alone is a valid entry — plenty of tasks are just 30 minutes.
  const totalMinutes = Math.round(hrs * 60 + mins);

  if (!(totalMinutes > 0)) {
    showStatus('Enter hours, minutes, or both.', 'error');
    setTimeout(hideStatus, 3000);
    return;
  }
  if (!dateStr) {
    showStatus('Pick a date for the time entry.', 'error');
    setTimeout(hideStatus, 3000);
    return;
  }

  const label = fmtDuration(totalMinutes);
  saveBtn.disabled = true;
  showStatus(`Logging ${label} to "${name}"...`, 'loading');

  try {
    await addTimeEntry(taskId, dateStr, totalMinutes);
    showStatus(`Logged ${label} to "${name}".`, 'success');
    setTimeout(hideStatus, 3000);
    // Remove the row immediately (covers the deep-scan list, which handleFetch won't rebuild)...
    state.deepscan = state.deepscan.filter(t => t.id !== taskId);
    item.remove();
    // ...then refresh timesheet + assigned-untracked list from source of truth so totals stay correct.
    await handleFetch();
  } catch (err) {
    showStatus(err.message || 'Failed to log time.', 'error');
    saveBtn.disabled = false;
  }
}

// ---------- Developer(s) scan: tasks you worked but aren't assigned to ----------
// Replaces the old watcher/creator deep scan. Watcher was inherited by every copy of a
// task template, so it produced heavy false positives. The Developer(s) field is set by
// hand and filters server-side, so this is one query with no per-task lookups — no cap,
// no concurrency pool, no coverage gap.

async function developerScan() {
  if (!state.token) return;
  if (!state.devOptionId) {
    showStatus('Pick your name under Developer(s) in step 1 first.', 'error');
    setTimeout(hideStatus, 4000);
    return;
  }

  const startMs = new Date($dateFrom.value + 'T00:00:00').getTime();
  const endMs   = new Date($dateTo.value   + 'T23:59:59').getTime();
  const userId  = String(state.user.id);

  $btnDeepscan.disabled = true;
  try {
    showStatus('Scanning tasks tagged with your name...', 'loading');
    const tasks = await fetchDeveloperTasks(state.teamId, state.token, state.devOptionId, startMs, endMs);

    // Drop what's already covered: tasks assigned to me (the Untracked card handles
    // those) and tasks I've already logged time against in this range.
    const loggedTaskIds = new Set(
      state.entries.map(en => (en.raw && en.raw.task) ? en.raw.task.id : null).filter(Boolean)
    );
    const seen = new Set();
    const flagged = tasks.filter(t => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      if (state.dismissed.has(t.id)) return false;
      if (loggedTaskIds.has(t.id)) return false;
      const assigneeIds = (t.assignees || []).map(a => String(a.id));
      if (assigneeIds.includes(userId)) return false;
      return true;
    });

    flagged.sort((a, b) => {
      const da = a.due_date ? parseInt(a.due_date) : Infinity;
      const db = b.due_date ? parseInt(b.due_date) : Infinity;
      if (da !== db) return da - db;
      return (a.name || '').localeCompare(b.name || '');
    });

    state.deepscan      = flagged;
    state.deepscanStats = { scanned: tasks.length };
    renderDeepScan(flagged, state.deepscanStats);
    hideStatus();
    showStatus(`Scan complete — ${flagged.length} task${flagged.length !== 1 ? 's' : ''} found.`, 'success');
    setTimeout(hideStatus, 3500);
  } catch (err) {
    showStatus(err.message || 'Developer scan failed.', 'error');
  } finally {
    $btnDeepscan.disabled = false;
  }
}

// One workspace-wide query: ClickUp filters the labels field server-side, so we never
// enumerate spaces or fetch tasks individually.
async function fetchDeveloperTasks(teamId, token, optionId, startMs, endMs) {
  const filter = JSON.stringify([
    { field_id: DEV_FIELD_ID, operator: 'ANY', value: [optionId] },
  ]);
  const base = `custom_fields=${encodeURIComponent(filter)}&subtasks=true&include_closed=true`;
  return fetchInRange(teamId, token, base, startMs, endMs);
}

// The field only carries *who*, never *when* — so a range starting before the team
// began filling it in would come back empty and read as "all clear". Say so instead.
function devFieldCoversRange() {
  return $dateFrom.value >= DEV_FIELD_START;
}

function updateDevScanAvailability() {
  const ready = Boolean(state.token && state.entries.length >= 0 && state.devOptionId);
  $btnDeepscan.disabled = !ready || $secDeepscan.classList.contains('disabled');
}

function renderDeepScan(list, stats) {
  $deepscanCount.textContent = list.length ? `${list.length} found` : 'None found';

  let html = '';

  if (!devFieldCoversRange()) {
    html += `<div class="deepscan-stats">⚠ Developer(s) tagging starts ${escHtml(DEV_FIELD_START)}. ` +
            `Tasks before then mostly have the field empty, so this scan can't see them — ` +
            `for earlier dates rely on the assigned-task check above.</div>`;
  }

  if (stats) {
    html += `<div class="deepscan-stats">${escHtml(`Scanned ${stats.scanned} tasks tagged with your name`)}</div>`;
  }

  if (list.length === 0) {
    html += `<div class="untracked-empty">No tasks tagged with your name are missing time in this range.</div>`;
  } else {
    const defaultDate = $dateTo.value;
    html += list.map(t => taskItemHTML(t, defaultDate, { showAssignee: true })).join('');
  }
  html += dismissedFooterHTML();

  $deepscanList.innerHTML = html;
}

// "90" -> "1h 30m", "30" -> "30m", "120" -> "2h"
function fmtDuration(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h && m) return `${h}h ${m}m`;
  return h ? `${h}h` : `${m}m`;
}

async function addTimeEntry(taskId, dateStr, totalMinutes) {
  const startMs    = new Date(dateStr + 'T09:00:00').getTime(); // 9am local on the chosen day
  const durationMs = Math.round(totalMinutes * 60000);
  // Omit assignee so ClickUp attributes the entry to the token owner (self).
  return cuPost(`/team/${state.teamId}/time_entries`, state.token, {
    tid: taskId,
    start: startMs,
    duration: durationMs,
    billable: false,
  });
}

function fmtDue(ms) {
  return new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Derive a "(CODE) Name" project code + label from a ClickUp list name.
// Resolves the client/project code for a row.
//
// Shared lists (SEM, SEO, CMS, Web Maintenance) carry no code in the list name, so the
// team puts the client code in the task title instead: "[333660996315]— Zebedee ...".
// The task code is the more specific of the two, so it wins over the list's.
//
// When nothing yields a code the answer is 'N/A', never the ClickUp list id — an
// internal id in the project column of a timesheet is noise, not data. 'N/A' rows can
// be filled in by hand in the table.
function parseProject(listName, listId, folderId, folderName, taskName) {
  const fromTask = extractTaskCode(taskName);
  let projectCode, projectInfo;

  if (listName) {
    // "(CODE) List Name" — leading code
    const leading  = listName.match(/^\(([^)]+)\)\s*(.+)$/);
    // "List Name (195154245335)" — trailing pure-numeric code
    const trailing = listName.match(/^(.*?)\s*\((\d+)\)\s*$/);

    if (leading) {
      projectCode = leading[1].trim();
      projectInfo = leading[2].trim();
    } else if (trailing) {
      projectCode = trailing[2];
      projectInfo = trailing[1].trim() || folderName || 'N/A';
    } else {
      projectCode = 'N/A';
      projectInfo = listName;
    }
  } else {
    projectCode = 'N/A';
    projectInfo = folderName || 'N/A';
  }

  // The task's own code is more specific than the list's, so it takes precedence.
  if (fromTask) projectCode = fromTask;

  if (!projectCode) projectCode = 'N/A';
  if (!projectInfo) projectInfo = 'N/A';
  return { projectCode, projectInfo };
}

// "[333660996315]— Zebedee Solution (Pte Ltd) - To Hide Product Page" -> "333660996315"
// Only a leading bracketed run of digits counts: a bracket elsewhere in a title is
// prose, not a code.
function extractTaskCode(taskName) {
  if (!taskName) return null;
  const m = String(taskName).match(/^\s*[\[(]\s*(\d{4,})\s*[\])]/);
  return m ? m[1] : null;
}

// ---------- Helpers ----------
function countWorkingDays(fromStr, toStr) {
  const from = new Date(fromStr + 'T00:00:00');
  const to   = new Date(toStr   + 'T00:00:00');
  let count  = 0;
  const d    = new Date(from);
  while (d <= to) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// ---------- Render ----------
function renderTable(entries) {
  $tableBody.innerHTML = '';

  if (entries.length === 0) {
    $tableBody.innerHTML = `<tr><td colspan="5" class="no-data">No entries found</td></tr>`;
    $summary.classList.add('hidden');
    $rowCount.textContent = '';
    return;
  }

  const totalTracked = entries.reduce((s, e) => s + e.hours, 0);
  const workingDays  = countWorkingDays($dateFrom.value, $dateTo.value);
  const actualHours  = workingDays * 8;
  const missing      = Math.max(0, actualHours - totalTracked);
  const projects     = new Set(entries.map(e => e.folderName).filter(Boolean)).size;

  $summary.innerHTML = `
    <div class="summary-item"><div class="label">Entries</div><div class="value">${entries.length}</div></div>
    <div class="summary-item"><div class="label">Projects</div><div class="value">${projects}</div></div>
    <div class="summary-item"><div class="label">Total Days</div><div class="value">${workingDays}</div></div>
    <div class="summary-item"><div class="label">Time Tracked</div><div class="value">${totalTracked.toFixed(1)} hrs</div></div>
    <div class="summary-item"><div class="label">Actual Hours</div><div class="value">${actualHours.toFixed(1)} hrs</div></div>
    <div class="summary-item ${missing > 0 ? 'missing' : ''}"><div class="label">Missing</div><div class="value">${missing.toFixed(1)} hrs</div></div>
  `;
  $summary.classList.remove('hidden');

  entries.forEach(e => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${codeCellHTML(e)}</td>
      <td>${escHtml(e.projectInfo)}</td>
      <td>${escHtml(e.taskName)}</td>
      <td>${escHtml(e.date)}</td>
      <td><span class="hours-val">${e.hours.toFixed(2)}</span></td>
    `;
    $tableBody.appendChild(tr);
  });

  const unresolved = entries.filter(e => e.projectCode === 'N/A').length;
  $rowCount.textContent = `${entries.length} row${entries.length !== 1 ? 's' : ''}` +
    (unresolved ? ` · ${unresolved} without a project code` : '');
}

// A resolved code renders as a badge; an unresolved one as a button that turns into an
// input, so the gap is fixable in place instead of after export.
function codeCellHTML(e) {
  const overridden = Boolean(e.taskId && state.codeOverrides[e.taskId]);

  if (e.projectCode !== 'N/A') {
    return `<span class="badge-code ${overridden ? 'is-manual' : ''}" data-task-id="${escHtml(e.taskId)}"
                  title="${overridden ? 'Entered by you — click to change' : 'Click to override'}"
                  role="button" tabindex="0">${escHtml(e.projectCode)}</span>`;
  }
  return `<button type="button" class="code-add" data-task-id="${escHtml(e.taskId)}">+ Add code</button>`;
}

// Swap the cell for an input. Enter or blur saves, Escape cancels.
function beginCodeEdit(cell, taskId, current) {
  const td = cell.closest('td');
  if (!td || td.querySelector('input')) return;

  td.innerHTML = `<input type="text" class="code-input" value="${escHtml(current === 'N/A' ? '' : current)}"
                         placeholder="Project code" aria-label="Project code" />`;
  const input = td.querySelector('input');
  input.focus();
  input.select();

  let settled = false;
  const commit = (save) => {
    if (settled) return;
    settled = true;
    if (save) {
      const val = input.value.trim();
      saveCodeOverride(taskId, val);
      // Re-derive from source so the entry, the table and the CSV agree.
      state.entries = state.entries.map(en =>
        en.taskId === taskId
          ? { ...en, projectCode: val || derivedCode(en) }
          : en);
    }
    renderTable(state.entries);
  };

  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter')  { ev.preventDefault(); commit(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}

// What the code would be without a manual override — used when one is cleared.
function derivedCode(entry) {
  const e = entry.raw || {};
  const loc = e.task_location || e.taskLocation || {};
  const listName = loc.list_name || loc.listName || e.task?.list?.name || '';
  const folderName = loc.folder_name || loc.folderName || e.task?.folder?.name || '';
  const folderId = loc.folder_id || loc.folderId || e.task?.folder?.id || '';
  const listId = loc.list_id || loc.listId || e.task?.list?.id || '';
  return parseProject(listName, listId, folderId, folderName, entry.taskName).projectCode;
}

function onTableClick(ev) {
  const addBtn = ev.target.closest('.code-add');
  if (addBtn) { beginCodeEdit(addBtn, addBtn.dataset.taskId, 'N/A'); return; }

  const badge = ev.target.closest('.badge-code');
  if (badge && badge.dataset.taskId) {
    beginCodeEdit(badge, badge.dataset.taskId, badge.textContent.trim());
  }
}

// ---------- Copy to clipboard ----------
// Spreadsheets read tab-separated text on paste, one row per line — so this drops
// straight into Sheets as cells without going through a file at all. Codes carry the
// same apostrophe as the CSV, which is what stops 0000 pasting as 0.
function tableAsTSV() {
  const headers = ['Project Code', 'Project Info', 'Task / Location', 'Date', 'Time Spent'];
  const rows = state.entries.map(e => [
    codeForSheet(e.projectCode),
    e.projectInfo,
    // A tab or newline inside a value would break the row apart — collapse them.
    String(e.taskName).replace(/[\t\r\n]+/g, ' '),
    e.date,
    e.hours.toFixed(2),
  ]);
  return [headers, ...rows].map(r => r.join('\t')).join('\n');
}

async function copyTable() {
  if (state.entries.length === 0) return;
  const text = tableAsTSV();

  try {
    await writeClipboard(text);
    const n = state.entries.length;
    showStatus(`Copied ${n} row${n !== 1 ? 's' : ''} — paste straight into your sheet.`, 'success');
    setTimeout(hideStatus, 3500);
    flashCopied();
  } catch (err) {
    showStatus('Couldn\'t copy to the clipboard. Use Export CSV instead.', 'error');
    setTimeout(hideStatus, 4000);
  }
}

// navigator.clipboard needs a secure context, and even then it rejects if the document
// isn't focused or a permissions policy blocks it. So try it, and fall through to the
// textarea route on *failure*, not just when the API is missing.
async function writeClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { return await navigator.clipboard.writeText(text); }
    catch (_) { /* fall through */ }
  }

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top      = '0';
  ta.style.opacity  = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, ta.value.length);   // iOS Safari needs the explicit range
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  document.body.removeChild(ta);
  if (!ok) throw new Error('copy failed');
}

function flashCopied() {
  const original = $btnCopy.innerHTML;
  $btnCopy.classList.add('is-copied');
  $btnCopy.innerHTML =
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied`;
  setTimeout(() => {
    $btnCopy.innerHTML = original;
    $btnCopy.classList.remove('is-copied');
  }, 1600);
}

// ---------- Export ----------
function exportCSV() {
  if (state.entries.length === 0) return;

  const headers = ['Project Code', 'Project Info', 'Task / Location', 'Date', 'Time Spent'];
  const rows    = state.entries.map(e => [
    e.projectCode,
    e.projectInfo,
    e.taskName,
    e.date,
    e.hours.toFixed(2),
  ]);

  const totalTracked = state.entries.reduce((s, e) => s + e.hours, 0);
  const workingDays  = countWorkingDays($dateFrom.value, $dateTo.value);
  const actualHours  = workingDays * 8;
  const missing      = Math.max(0, actualHours - totalTracked);

  const totalsRows = [
    ['', '', '', '', ''],
    ['TOTAL Days', workingDays, '', '', ''],
    ['TOTAL Time Tracked (hrs)', totalTracked.toFixed(1), '', '', ''],
    ['TOTAL Actual Time of the Months (hrs)', actualHours.toFixed(1), '', '', ''],
    ['TOTAL Missing Time Track (hrs)', missing.toFixed(1), '', '', ''],
  ];

  // Only the data rows' first column is a project code. The header, the blank spacer and
  // the totals rows keep plain formatting so their numbers stay numbers Excel can sum.
  const encodeRow = (row, forceCodeCol) =>
    row.map((cell, i) =>
      (forceCodeCol && i === 0) ? csvCodeCell(cell) : csvCell(String(cell))
    ).join(',');

  const csv = [
    encodeRow(headers, false),
    ...rows.map(r => encodeRow(r, true)),
    ...totalsRows.map(r => encodeRow(r, false)),
  ].join('\r\n');

  const from = $dateFrom.value;
  const to   = $dateTo.value;
  const name = `${state.user.username.replace(/\s+/g, '_')}_timesheet_${from}_${to}.csv`;

  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);

  showStatus('CSV downloaded: ' + name, 'success');
  setTimeout(hideStatus, 4000);
}

function csvCell(val) {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

// Project codes are identifiers, not quantities, but spreadsheets coerce anything
// all-digits into a number: 333660996315 becomes 3.3366E+11, and 0000 / 0004 lose their
// leading zeros to become 0 / 4. Prefixing with an apostrophe is the text marker both
// Google Sheets and Excel understand, and — unlike the ="0000" form — it survives a
// **copy-paste** into a sheet, not just a file import. Pasting is the actual workflow.
//
// Only digit-only values get it: "0000-ADMIN" is already safe as text, and the narrow
// rule avoids marking cells that don't need it.
function codeForSheet(val) {
  const s = String(val);
  return /^\d+$/.test(s) ? "'" + s : s;
}

function csvCodeCell(val) {
  return csvCell(codeForSheet(val));
}

// ---------- API helpers ----------
async function cuGet(path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: token },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.err || `ClickUp API error ${res.status}`);
  }

  return res.json();
}

async function cuPost(path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new Error(b.err || `ClickUp API error ${res.status}`);
  }

  return res.json();
}

// ---------- UI helpers ----------
function showStatus(msg, type = 'loading') {
  $statusBar.className = 'status-bar ' + type;
  $statusBar.innerHTML = type === 'loading'
    ? `<span class="spinner"></span><span>${escHtml(msg)}</span>`
    : `<span>${escHtml(msg)}</span>`;
  $statusBar.classList.remove('hidden');
}

function hideStatus() {
  $statusBar.classList.add('hidden');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
