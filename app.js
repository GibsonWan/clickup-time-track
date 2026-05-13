const API = 'https://api.clickup.com/api/v2';

// ---------- State ----------
let state = {
  token: '',
  user: null,
  teamId: null,
  entries: [],
};

// ---------- DOM refs ----------
const $token      = document.getElementById('api-token');
const $btnConnect = document.getElementById('btn-connect');
const $userInfo   = document.getElementById('user-info');
const $secDates   = document.getElementById('section-dates');
const $secExport  = document.getElementById('section-export');
const $dateFrom   = document.getElementById('date-from');
const $dateTo     = document.getElementById('date-to');
const $btnFetch   = document.getElementById('btn-fetch');
const $tableBody  = document.getElementById('table-body');
const $summary    = document.getElementById('summary');
const $rowCount   = document.getElementById('row-count');
const $btnExport  = document.getElementById('btn-export');
const $statusBar  = document.getElementById('status-bar');

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

    state.token  = token;
    state.user   = user.user;
    state.teamId = teams.teams[0].id;

    sessionStorage.setItem('cu_token', token);

    renderUserInfo(state.user);
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

  const d        = new Date(parseInt(e.start));
  const date     = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const sortDate = d.toISOString().slice(0, 10);

  const durationMs = parseInt(e.duration || 0);
  const hours      = +(durationMs / 3600000).toFixed(2);

  return { date, sortDate, projectCode, projectInfo, taskName, hours, folderName, raw: e };
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
