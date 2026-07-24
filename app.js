const API = 'https://api.clickup.com/api/v2';

// ---------- State ----------
let state = {
  token: '',
  user: null,
  teams: [],
  teamId: null,
  entries: [],
  untracked: [],
  deepscan: [],
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
const $statusBar   = document.getElementById('status-bar');
const $untrackedList  = document.getElementById('untracked-list');
const $untrackedCount = document.getElementById('untracked-count');
const $secDeepscan    = document.getElementById('section-deepscan');
const $btnDeepscan    = document.getElementById('btn-deepscan');
const $deepscanList   = document.getElementById('deepscan-list');
const $deepscanCount  = document.getElementById('deepscan-count');

// ---------- Init ----------
(function init() {
  const saved = sessionStorage.getItem('cu_token');
  if (saved) { $token.value = saved; }
  setDefaultDates();
  bindEvents();
})();

function setDefaultDates() {
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDay  = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  $dateFrom.value = fmt(firstDay);
  $dateTo.value   = fmt(lastDay);
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

// ---------- Events ----------
function bindEvents() {
  $btnConnect.addEventListener('click', handleConnect);
  $token.addEventListener('keydown', e => { if (e.key === 'Enter') handleConnect(); });

  $btnFetch.addEventListener('click', handleFetch);

  document.querySelectorAll('[data-range]').forEach(btn => {
    btn.addEventListener('click', () => applyQuickRange(btn.dataset.range));
  });

  $dateFrom.addEventListener('change', validateDates);
  $dateTo.addEventListener('change', validateDates);

  $btnExport.addEventListener('click', exportCSV);

  $wsSelect.addEventListener('change', () => { state.teamId = $wsSelect.value; });
  $untrackedList.addEventListener('click', onUntrackedClick);
  $btnDeepscan.addEventListener('click', deepScan);
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
async function handleConnect() {
  const token = $token.value.trim();
  if (!token) { showStatus('Paste your ClickUp API token first.', 'error'); return; }

  showStatus('Connecting...', 'loading');
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

    sessionStorage.setItem('cu_token', token);

    renderUserInfo(state.user);
    renderWorkspaces(state.teams, state.teamId);
    $secDates.classList.remove('disabled');
    validateDates();
    hideStatus();
    showStatus('Connected as ' + state.user.username, 'success');
    setTimeout(hideStatus, 3000);
  } catch (err) {
    showStatus(err.message || 'Connection failed. Check your token.', 'error');
  } finally {
    $btnConnect.disabled = false;
  }
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

    // Phase 1: find tasks assigned to me, active in this range, with no time logged.
    await loadUntracked(startMs, endMs, entries);

    // Deep scan is available once a range is fetched (it reuses these entries + dates).
    $secDeepscan.classList.remove('disabled');
    $btnDeepscan.disabled = false;

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

  // Log first entry so we can inspect the real API shape in DevTools console
  if (raw.length > 0) {
    console.log('[CU Export] first entry keys:', Object.keys(raw[0]));
    console.log('[CU Export] first entry:', JSON.stringify(raw[0], null, 2));
  }

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
    await Promise.all(
      missingIds.map(async id => {
        try {
          const t = await cuGet(`/task/${id}`, token);
          taskCache[id] = t;
        } catch (_) {}
      })
    );
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

  const { projectCode, projectInfo } = parseListName(listName, listId, folderId, folderName);

  const d        = new Date(parseInt(e.start));
  const date     = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const sortDate = d.toISOString().slice(0, 10);

  const durationMs = parseInt(e.duration || 0);
  const hours      = +(durationMs / 3600000).toFixed(2);

  return { date, sortDate, projectCode, projectInfo, taskName, hours, folderName, raw: e };
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
  const tasks = [];
  // Scope to tasks DUE within the selected range (not merely updated in it), so only
  // tasks that belonged to this period appear — no out-of-period noise.
  for (let page = 0; page < 15; page++) {
    const qs =
      `page=${page}` +
      `&assignees%5B%5D=${encodeURIComponent(userId)}` +
      `&due_date_gt=${startMs - 1}` +
      `&due_date_lt=${endMs + 1}` +
      `&subtasks=true&include_closed=true`;
    const data  = await cuGet(`/team/${teamId}/task?${qs}`, token);
    const batch = data.tasks || [];
    tasks.push(...batch);
    if (batch.length < 100) break; // last page
  }
  return tasks;
}

function renderUntracked() {
  const list = state.untracked;

  $untrackedCount.textContent = list.length
    ? `${list.length} task${list.length !== 1 ? 's' : ''}`
    : 'All clear';

  if (list.length === 0) {
    $untrackedList.innerHTML =
      `<div class="untracked-empty">Every task assigned to you and due in this range has time logged. 🎉</div>`;
    return;
  }

  const defaultDate = $dateTo.value; // within the fetched range, so the row clears after logging
  $untrackedList.innerHTML = list.map(t => taskItemHTML(t, defaultDate, { showAssignee: false })).join('');
}

// Shared markup for a task row with an inline "Add time" form. Used by both the
// assigned-untracked list and the deep-scan list.
function taskItemHTML(t, defaultDate, opts = {}) {
  const listObj  = t.list || {};
  const { projectCode } = parseListName(listObj.name || '', listObj.id || '', '', '');
  const status   = t.status && t.status.status ? t.status.status : '';
  const dueLabel = t.due_date ? fmtDue(parseInt(t.due_date)) : '';
  const url      = t.url || `https://app.clickup.com/t/${t.id}`;
  const name     = t.name || '(untitled task)';
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
          <input type="number" class="input u-hours" min="0.25" step="0.25" placeholder="Hrs" aria-label="Hours" />
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
    </div>`;
}

// Inline "Add time" handling (event-delegated on the untracked list).
async function onUntrackedClick(e) {
  const item = e.target.closest('.untracked-item');
  if (!item) return;

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
  const hours   = parseFloat(item.querySelector('.u-hours').value);
  const dateStr = item.querySelector('.u-date').value;

  if (!(hours > 0)) {
    showStatus('Enter a number of hours greater than 0.', 'error');
    setTimeout(hideStatus, 3000);
    return;
  }
  if (!dateStr) {
    showStatus('Pick a date for the time entry.', 'error');
    setTimeout(hideStatus, 3000);
    return;
  }

  saveBtn.disabled = true;
  showStatus(`Logging ${hours}h to "${name}"...`, 'loading');

  try {
    await addTimeEntry(taskId, dateStr, hours);
    showStatus(`Logged ${hours}h to "${name}".`, 'success');
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

// ---------- Deep scan: handed-off tasks (watcher/creator based) ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DEEPSCAN_CAP = 150; // max per-task involvement lookups per scan

async function deepScan() {
  if (!state.token) return;

  const startMs = new Date($dateFrom.value + 'T00:00:00').getTime();
  const endMs   = new Date($dateTo.value   + 'T23:59:59').getTime();
  const userId  = String(state.user.id);

  $btnDeepscan.disabled = true;
  try {
    showStatus('Deep scan: loading spaces...', 'loading');
    const spaceIds = await fetchSpaces(state.teamId, state.token);

    showStatus(`Deep scan: fetching tasks across ${spaceIds.length} space${spaceIds.length !== 1 ? 's' : ''}...`, 'loading');
    const tasks = await fetchSpaceTasks(state.teamId, state.token, spaceIds, startMs, endMs);

    // Candidates: active in range, not already mine by assignment, and no time logged by me.
    const loggedTaskIds = new Set(state.entries.map(en => (en.raw && en.raw.task) ? en.raw.task.id : null).filter(Boolean));
    const seen = new Set();
    const candidates = tasks.filter(t => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      if (loggedTaskIds.has(t.id)) return false;
      const assigneeIds = (t.assignees || []).map(a => String(a.id));
      if (assigneeIds.includes(userId)) return false; // already covered by the Untracked card
      return true;
    });

    let flagged, checked, capped = 0;

    // Fast path: if the bulk list ever includes watchers, no per-task calls needed.
    if (candidates.length > 0 && Array.isArray(candidates[0].watchers)) {
      flagged = candidates.filter(t => isMine(t, userId));
      checked = candidates.length;
    } else {
      const res = await checkInvolvement(candidates, userId, state.token, DEEPSCAN_CAP);
      flagged = res.flagged;
      checked = res.checked;
      capped  = res.capped;
    }

    flagged.sort((a, b) => {
      const da = a.due_date ? parseInt(a.due_date) : Infinity;
      const db = b.due_date ? parseInt(b.due_date) : Infinity;
      if (da !== db) return da - db;
      return (a.name || '').localeCompare(b.name || '');
    });

    state.deepscan = flagged;
    renderDeepScan(flagged, { scanned: tasks.length, candidates: candidates.length, checked, capped });
    hideStatus();
    showStatus(`Deep scan complete — ${flagged.length} task${flagged.length !== 1 ? 's' : ''} found.`, 'success');
    setTimeout(hideStatus, 3500);
  } catch (err) {
    showStatus(err.message || 'Deep scan failed.', 'error');
  } finally {
    $btnDeepscan.disabled = false;
  }
}

function isMine(fullTask, userId) {
  const watchers = fullTask.watchers || [];
  const isWatcher = watchers.some(w => String(w.id) === userId);
  const isCreator = fullTask.creator && String(fullTask.creator.id) === userId;
  return isWatcher || isCreator;
}

async function fetchSpaces(teamId, token) {
  const data = await cuGet(`/team/${teamId}/space?archived=false`, token);
  return (data.spaces || []).map(s => s.id);
}

async function fetchSpaceTasks(teamId, token, spaceIds, startMs, endMs) {
  const spaceParams = spaceIds.map(id => `space_ids%5B%5D=${encodeURIComponent(id)}`).join('&');
  const tasks = [];
  for (let page = 0; page < 30; page++) { // safety cap: 3000 tasks
    const qs =
      `page=${page}&${spaceParams}` +
      `&due_date_gt=${startMs - 1}&due_date_lt=${endMs + 1}` +
      `&subtasks=true&include_closed=true`;
    const data  = await cuGet(`/team/${teamId}/task?${qs}`, token);
    const batch = data.tasks || [];
    tasks.push(...batch);
    if (batch.length < 100) break;
  }
  return tasks;
}

// Per-task involvement check with a concurrency pool, cap, and 429 backoff.
async function checkInvolvement(candidates, userId, token, cap) {
  const toCheck = candidates.slice(0, cap);
  const capped  = candidates.length - toCheck.length;
  const flagged = [];
  let checked = 0;
  let idx = 0;
  const POOL = 4;

  async function worker() {
    while (idx < toCheck.length) {
      const t = toCheck[idx++];
      try {
        const full = await getTaskWithRetry(t.id, token);
        checked++;
        if (isMine(full, userId)) {
          flagged.push({ ...t, assignees: full.assignees || t.assignees, creator: full.creator });
        }
      } catch (_) { /* skip tasks that error out */ }
      if (checked % 10 === 0) {
        showStatus(`Deep scan: checked ${checked}/${toCheck.length} tasks...`, 'loading');
      }
    }
  }

  await Promise.all(Array.from({ length: POOL }, worker));
  return { flagged, checked, capped };
}

async function getTaskWithRetry(taskId, token, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return await cuGet(`/task/${taskId}`, token);
    } catch (e) {
      if (/\b429\b/.test(e.message) && i < tries - 1) { await sleep(2500); continue; }
      throw e;
    }
  }
}

function renderDeepScan(list, stats) {
  $deepscanCount.textContent = list.length ? `${list.length} found` : 'None found';

  let html = '';
  if (stats) {
    let note = `Scanned ${stats.scanned} tasks · ${stats.candidates} candidates · checked ${stats.checked} for your involvement`;
    if (stats.capped > 0) {
      note += ` · ⚠ ${stats.capped} not checked (scan cap reached — narrow the date range or it won't cover everything)`;
    }
    html += `<div class="deepscan-stats">${escHtml(note)}</div>`;
  }

  if (list.length === 0) {
    html += `<div class="untracked-empty">No handed-off tasks you're involved in are missing time in this range.</div>`;
  } else {
    const defaultDate = $dateTo.value;
    html += list.map(t => taskItemHTML(t, defaultDate, { showAssignee: true })).join('');
  }

  $deepscanList.innerHTML = html;
}

async function addTimeEntry(taskId, dateStr, hours) {
  const startMs    = new Date(dateStr + 'T09:00:00').getTime(); // 9am local on the chosen day
  const durationMs = Math.round(hours * 3600000);
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
function parseListName(listName, listId, folderId, folderName) {
  let projectCode, projectInfo;

  if (listName) {
    // "(CODE) List Name" — leading code takes priority
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
      projectCode = listId || folderId || 'N/A';
      projectInfo = listName;
    }
  } else {
    projectCode = folderId || 'N/A';
    projectInfo = folderName || 'N/A';
  }

  if (!projectCode) projectCode = 'N/A';
  if (!projectInfo) projectInfo = 'N/A';
  return { projectCode, projectInfo };
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
      <td>${e.projectCode !== 'N/A' ? `<span class="badge-code">${escHtml(e.projectCode)}</span>` : '<span style="color:var(--text-muted)">N/A</span>'}</td>
      <td>${escHtml(e.projectInfo)}</td>
      <td>${escHtml(e.taskName)}</td>
      <td>${escHtml(e.date)}</td>
      <td><span class="hours-val">${e.hours.toFixed(2)}</span></td>
    `;
    $tableBody.appendChild(tr);
  });

  $rowCount.textContent = `${entries.length} row${entries.length !== 1 ? 's' : ''}`;
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

  const csv = [headers, ...rows, ...totalsRows]
    .map(row => row.map(cell => csvCell(String(cell))).join(','))
    .join('\r\n');

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
