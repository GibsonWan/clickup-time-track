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
  return (data.data || []).map(parseEntry);
}

function parseEntry(e) {
  const taskName    = e.task ? e.task.name : '(no task)';
  const listName    = e.task?.list?.name  || '';
  const folderName  = e.task?.folder?.name || '';

  // Parse "(CODE) Title" from list name
  const match = listName.match(/^\(([^)]+)\)\s*(.+)$/);
  const projectCode  = match ? match[1].trim() : '';
  const projectTitle = match ? match[2].trim() : (listName || folderName || '');

  const date         = new Date(parseInt(e.start)).toISOString().slice(0, 10);
  const durationMs   = parseInt(e.duration || 0);
  const hours        = +(durationMs / 3600000).toFixed(2);
  const description  = e.description || '';

  return { date, projectCode, projectTitle, taskName, hours, description, raw: e };
}

// ---------- Render ----------
function renderTable(entries) {
  $tableBody.innerHTML = '';

  if (entries.length === 0) {
    $tableBody.innerHTML = `<tr><td colspan="6" class="no-data">No entries found</td></tr>`;
    $summary.classList.add('hidden');
    $rowCount.textContent = '';
    return;
  }

  const totalHours = entries.reduce((s, e) => s + e.hours, 0);
  const projects   = new Set(entries.map(e => e.projectCode || e.projectTitle)).size;

  $summary.innerHTML = `
    <div class="summary-item"><div class="label">Entries</div><div class="value">${entries.length}</div></div>
    <div class="summary-item"><div class="label">Total Hours</div><div class="value">${totalHours.toFixed(2)}</div></div>
    <div class="summary-item"><div class="label">Projects</div><div class="value">${projects}</div></div>
  `;
  $summary.classList.remove('hidden');

  entries.forEach(e => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escHtml(e.date)}</td>
      <td>${e.projectCode ? `<span class="badge-code">${escHtml(e.projectCode)}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>${escHtml(e.projectTitle)}</td>
      <td>${escHtml(e.taskName)}</td>
      <td><span class="hours-val">${e.hours.toFixed(2)}</span></td>
      <td class="desc-cell">${escHtml(e.description)}</td>
    `;
    $tableBody.appendChild(tr);
  });

  $rowCount.textContent = `${entries.length} row${entries.length !== 1 ? 's' : ''}`;
}

// ---------- Export ----------
function exportCSV() {
  if (state.entries.length === 0) return;

  const headers = ['Date', 'Project Code', 'Project Title', 'Task Name', 'Hours', 'Description'];
  const rows    = state.entries.map(e => [
    e.date,
    e.projectCode,
    e.projectTitle,
    e.taskName,
    e.hours.toFixed(2),
    e.description,
  ]);

  const csv = [headers, ...rows]
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
