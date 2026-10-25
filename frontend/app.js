(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const ICON = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const WP_KEY = 'shiftswap-workplace';
  const TONES = ['', 'a2', 'a3', 'a4', 'a5'];

  // --- server data (everything below is loaded from /api) ---
  let user = null;          // {id, name, email, workplaces: [...]}
  let wp = null;            // current workplace {id, name, is_manager, invite_code?}
  let members = [];         // [{id, name, is_manager, roles: [{id, name}]}]
  let roles = [];           // [{id, name}]
  let shifts = [];          // shifts in the shown week, in the shape the calendar uses
  let boxes = {received: [], sent: [], history: []};
  let pending = [];         // manager approval queue
  let notes = {unread: 0, items: []};
  let saved = {weekly: [], exceptions: []}; // availability as loaded, for diffing on save

  // --- small helpers ---
  const parseDate = s => new Date(s + 'T12:00:00');
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return iso(d); };
  const weekOf = s => addDays(s, -(parseDate(s).getDay() + 6) % 7);
  const dayName = s => parseDate(s).toLocaleDateString('en-US', {weekday: 'short'});
  const longDay = s => parseDate(s).toLocaleDateString('en-US', {weekday: 'long', month: 'short', day: 'numeric', year: 'numeric'});
  const shortDay = s => parseDate(s).toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric'});
  const time = h => { const hours = Math.floor(h) % 24, mins = Math.round((h - Math.floor(h)) * 60), suffix = hours >= 12 ? 'PM' : 'AM'; return `${hours % 12 || 12}:${String(mins).padStart(2, '0')} ${suffix}`; };
  const shortTime = h => time(h).replace(':00', '');
  const span = (a, b) => `${shortTime(a)} – ${shortTime(b)}`;
  // 'HH:MM' <-> hours as a number (9.5 = 09:30); the API stores text, the UI does math
  const toHours = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h + m / 60; };
  const toHHMM = h => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h - Math.floor(h)) * 60)).padStart(2, '0')}`;
  const today = () => iso(new Date());
  const nowISO = () => { const d = new Date(); return `${iso(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const describeStatus = s => ({awaiting_coworker: 'Waiting for coworker', awaiting_manager: 'Waiting for manager', approved: 'Approved', declined: 'Declined', canceled: 'Canceled'})[s] || s;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const initials = name => String(name || '?').trim().split(/\s+/).map(v => v[0]).slice(0, 2).join('').toUpperCase();
  const tone = id => TONES[(id || 0) % TONES.length];
  const avatar = (name, id) => `<span class="avatar ${tone(id)}" aria-hidden="true">${esc(initials(name))}</span>`;
  // created_at comes from SQLite as UTC 'YYYY-MM-DD HH:MM:SS'
  const ago = ts => {
    if (!ts) return '';
    const mins = Math.round((Date.now() - new Date(ts.replace(' ', 'T') + 'Z')) / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins} min ago`;
    if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
    return new Date(ts.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
  };
  const formatRange = start => { const end = addDays(start, 6), d = parseDate(start), e = parseDate(end); const sm = d.toLocaleDateString('en-US', {month: 'short'}), em = e.toLocaleDateString('en-US', {month: 'short'}); return `${sm} ${d.getDate()} – ${d.getMonth() === e.getMonth() ? '' : em + ' '}${e.getDate()}, ${e.getFullYear()}`; };
  const submitter = e => e.submitter || e.target.querySelector('[type=submit]');
  const showError = (id, message) => { $(id).textContent = message; $(id).hidden = !message; };

  // --- API ---
  async function api(path, {method = 'GET', body} = {}) {
    const res = await fetch('/api' + path, {
      method,
      headers: body ? {'Content-Type': 'application/json'} : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const err = new Error((data && data.error) || `Something went wrong (${res.status})`);
      err.status = res.status;
      if (res.status === 401 && user) { user = null; showGate('login'); }
      throw err;
    }
    return data;
  }
  // run an action, toast its error instead of throwing; returns true on success
  async function attempt(fn, button) {
    if (button) button.disabled = true;
    try { await fn(); return true; }
    catch (e) { toast(e.message); return false; }
    finally { if (button) button.disabled = false; }
  }

  // API shift row -> calendar shift
  function toShift(s) {
    const date = s.start_dt.slice(0, 10), endDate = s.end_dt.slice(0, 10);
    let end = toHours(s.end_dt.slice(11));
    if (endDate > date) end += 24; // ends after midnight
    return {
      id: s.id, date, start: toHours(s.start_dt.slice(11)), end,
      title: s.role_name, person: s.assignee_name, personId: s.assignee_id,
      mine: s.assignee_id === user.id, open: s.open_requests > 0,
      startDt: s.start_dt, endDt: s.end_dt,
    };
  }

  // --- sign in / sign up / workplace setup ---
  function showGate(view) {
    $('app').hidden = true; $('gate').hidden = false;
    $('loginForm').hidden = view !== 'login';
    $('registerForm').hidden = view !== 'register';
    $('setupPanel').hidden = view !== 'setup';
    ['loginError', 'registerError', 'setupError'].forEach(id => showError(id, ''));
    document.querySelectorAll('dialog[open]').forEach(d => d.close());
    document.title = 'ShiftSwap';
    const first = {login: 'loginEmail', register: 'registerName', setup: 'setupJoinCode'}[view];
    setTimeout(() => $(first)?.focus(), 0);
  }
  $('showRegister').onclick = () => showGate('register');
  $('showLogin').onclick = () => showGate('login');
  $('loginForm').onsubmit = async e => {
    e.preventDefault();
    const btn = submitter(e);
    try {
      btn.disabled = true;
      await api('/login', {method: 'POST', body: {email: $('loginEmail').value, password: $('loginPassword').value}});
      $('loginForm').reset();
      await boot();
    } catch (err) { showError('loginError', err.message); }
    finally { btn.disabled = false; }
  };
  $('registerForm').onsubmit = async e => {
    e.preventDefault();
    const btn = submitter(e);
    try {
      btn.disabled = true;
      await api('/register', {method: 'POST', body: {name: $('registerName').value, email: $('registerEmail').value, password: $('registerPassword').value}});
      $('registerForm').reset();
      await boot();
    } catch (err) { showError('registerError', err.message); }
    finally { btn.disabled = false; }
  };
  async function joinWorkplace(code) { const w = await api('/workplaces/join', {method: 'POST', body: {invite_code: code}}); return w.id; }
  async function createWorkplace(name) { const w = await api('/workplaces', {method: 'POST', body: {name}}); return w.id; }
  async function enterWorkplace(id) { try { localStorage.setItem(WP_KEY, String(id)); } catch (e) {} await boot(); }
  $('setupJoinForm').onsubmit = async e => { e.preventDefault(); try { await enterWorkplace(await joinWorkplace($('setupJoinCode').value)); } catch (err) { showError('setupError', err.message); } };
  $('setupCreateForm').onsubmit = async e => { e.preventDefault(); try { await enterWorkplace(await createWorkplace($('setupCreateName').value)); location.hash = '#manager'; } catch (err) { showError('setupError', err.message); } };
  async function signOut() { try { await api('/logout', {method: 'POST'}); } catch (e) {} user = null; showGate('login'); }
  $('setupSignout').onclick = signOut;
  $('confirmSignout').onclick = signOut;

  async function boot() {
    try { user = await api('/me'); }
    catch (e) { showGate('login'); return; }
    if (!user.workplaces.length) { showGate('setup'); return; }
    let wanted = null;
    try { wanted = Number(localStorage.getItem(WP_KEY)); } catch (e) {}
    wp = user.workplaces.find(w => w.id === wanted) || user.workplaces[0];
    // fresh view state, so nothing carries over from a previous account or workplace
    activeTab = 'received'; scheduleFilter = 'all'; shownWeek = weekOf(today()); selectedDay = today();
    $('gate').hidden = true; $('app').hidden = false;
    $('profileName').textContent = user.name;
    $('profileAvatar').textContent = initials(user.name);
    $('profileAvatar').className = 'avatar ' + tone(user.id);
    $('profileRole').textContent = wp.is_manager ? 'Manager' : 'Team member';
    $('workspaceName').textContent = wp.name;
    $('managerNav').hidden = !wp.is_manager;
    await Promise.all([loadTeam(), loadRequests(), loadNotifications(), wp.is_manager ? loadPending() : null]);
    route();
  }

  // --- loaders ---
  async function loadTeam() {
    [members, roles] = await Promise.all([api(`/workplaces/${wp.id}/members`), api(`/workplaces/${wp.id}/roles`)]);
  }
  async function loadShifts() {
    const rows = await api(`/workplaces/${wp.id}/shifts?from=${shownWeek}T00:00&to=${addDays(shownWeek, 7)}T00:00`);
    shifts = rows.map(toShift);
  }
  async function loadRequests() {
    const [received, sent, history] = await Promise.all(['received', 'sent', 'history'].map(b => api('/requests?box=' + b)));
    const here = r => r.workplace_id === wp.id;
    boxes = {received: received.filter(here), sent: sent.filter(here), history: history.filter(here)};
  }
  async function loadPending() { pending = wp.is_manager ? await api(`/workplaces/${wp.id}/pending`) : []; }
  async function loadNotifications() { notes = await api('/notifications'); }
  async function refreshAll() {
    await Promise.all([loadRequests(), loadNotifications(), loadPending()]);
    renderAll();
  }

  // --- navigation ---
  let activePage = 'schedule', activeTab = 'received', scheduleFilter = 'all';
  let shownWeek = weekOf(today()), selectedDay = today(), selectedShift = null, toastTimer = null, commandIndex = 0, commands = [];
  let availableDraft = [], exceptionsDraft = [];
  let theme = 'system'; try { theme = localStorage.getItem('shiftswap-editorial-theme') || 'system'; } catch (e) {}

  function renderNavigation() {
    document.querySelectorAll('[data-nav]').forEach(a => { const active = a.dataset.nav === activePage; a.classList.toggle('active', active); active ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
    $('requestNavCount').textContent = boxes.received.length || '';
    $('managerNavCount').textContent = pending.length || '';
    $('unreadDot').hidden = !notes.unread;
    renderNotifications();
  }
  function navigate(page, force = false) {
    if (!user || !wp) return;
    if (!['schedule', 'requests', 'availability', 'manager'].includes(page)) page = 'schedule';
    if (page === 'manager' && !wp.is_manager) page = 'schedule';
    if (activePage === 'availability' && page !== 'availability' && isDirty() && !force) {
      if (!confirm('Leave Availability without saving your changes?')) { location.hash = '#availability'; return; }
      resetDraft();
    }
    activePage = page;
    document.querySelectorAll('.page').forEach(el => { el.hidden = el.id !== 'page-' + page; });
    renderNavigation(); closeMobile();
    renderPage(page);
    document.title = `${{schedule: 'Team schedule', requests: 'Requests', availability: 'Availability', manager: 'Manager'}[page]} · ShiftSwap`;
  }
  function renderPage(page) {
    if (page === 'schedule') loadShifts().then(renderSchedule).catch(e => toast(e.message));
    if (page === 'requests') renderRequests();
    if (page === 'availability') loadAvailability().catch(e => toast(e.message));
    if (page === 'manager') Promise.all([loadPending(), loadTeam()]).then(renderManager).catch(e => toast(e.message));
  }
  const route = () => navigate(location.hash.slice(1) || 'schedule');
  window.addEventListener('hashchange', route);
  function renderAll() {
    renderNavigation();
    if (activePage === 'schedule') renderPage('schedule');
    if (activePage === 'requests') renderRequests();
    if (activePage === 'manager') renderManager();
  }
  function closeMobile() { $('sidebar').classList.remove('is-open'); $('mobileShade').hidden = true; $('mobileMenuButton').setAttribute('aria-expanded', 'false'); }
  $('mobileMenuButton').onclick = () => { const open = $('sidebar').classList.toggle('is-open'); $('mobileShade').hidden = !open; $('mobileMenuButton').setAttribute('aria-expanded', String(open)); };
  $('mobileShade').onclick = closeMobile;

  // --- toasts and dialogs ---
  function toast(message) { clearTimeout(toastTimer); $('toastText').textContent = message; $('toast').hidden = false; $('toastUndo').hidden = true; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000); }
  const openDialog = id => { const el = $(id); if (!el.open) el.showModal(); };
  const closeDialog = id => { if ($(id).open) $(id).close(); };
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeDialog(b.dataset.close)));
  document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

  // --- workplaces ---
  $('workspaceButton').onclick = () => {
    $('workspaceList').innerHTML = user.workplaces.map(w => `<button type="button" class="workspace-option" data-wp="${w.id}" aria-current="${w.id === wp.id}"><span><strong>${esc(w.name)}</strong><br><small>${w.is_manager ? 'Manager · code ' + esc(w.invite_code) : 'Team member'}</small></span>${w.id === wp.id ? ICON('check') : ''}</button>`).join('');
    $('workspaceList').querySelectorAll('[data-wp]').forEach(b => b.onclick = () => { closeDialog('workspaceDialog'); enterWorkplace(Number(b.dataset.wp)); });
    $('joinForm').reset(); $('createForm').reset(); showError('workspaceError', '');
    openDialog('workspaceDialog');
  };
  $('joinForm').onsubmit = async e => { e.preventDefault(); try { const id = await joinWorkplace($('joinCode').value); closeDialog('workspaceDialog'); await enterWorkplace(id); toast('Joined workplace.'); } catch (err) { showError('workspaceError', err.message); } };
  $('createForm').onsubmit = async e => { e.preventDefault(); try { const id = await createWorkplace($('createName').value); closeDialog('workspaceDialog'); await enterWorkplace(id); location.hash = '#manager'; toast('Workplace created. Add roles and share the invite code.'); } catch (err) { showError('workspaceError', err.message); } };

  // --- schedule ---
  function renderSchedule() {
    $('weekLabel').textContent = formatRange(shownWeek);
    const mine = shifts.filter(s => s.mine);
    const hours = mine.reduce((sum, s) => sum + s.end - s.start, 0);
    $('scheduleOverview').textContent = `${mine.length} shift${mine.length === 1 ? '' : 's'} · ${Math.round(hours * 4) / 4} hour${hours === 1 ? '' : 's'}`;
    document.querySelectorAll('[data-schedule-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scheduleFilter === scheduleFilter)));
    const filtered = shifts.filter(s => scheduleFilter === 'all' || s.mine);
    // the visible hours stretch to fit early or late shifts; 8 AM – 9 PM by default
    const H0 = Math.min(8, ...filtered.map(s => Math.floor(s.start)));
    const H1 = Math.max(21, ...filtered.map(s => Math.ceil(Math.min(s.end, 24))));
    const rowsTall = (H1 - H0) * 56;
    const cal = $('calendar'); cal.replaceChildren();
    cal.style.gridTemplateRows = `56px ${rowsTall}px`;
    const corner = document.createElement('div'); corner.className = 'calendar-corner'; cal.append(corner);
    for (let i = 0; i < 7; i++) {
      const date = addDays(shownWeek, i), head = document.createElement('div'); head.className = 'day-head'; head.style.gridColumn = String(i + 2);
      head.innerHTML = `<span>${dayName(date)}</span><span class="date-number numeric ${date === today() ? 'today' : ''}">${parseDate(date).getDate()}</span>`;
      cal.append(head);
    }
    const axis = document.createElement('div'); axis.className = 'time-axis';
    for (let h = H0; h <= H1; h++) { const mark = document.createElement('span'); mark.className = 'time-mark numeric' + (h === H0 ? ' first' : ''); mark.textContent = shortTime(h); mark.style.top = `${(h - H0) * 56}px`; axis.append(mark); }
    cal.append(axis);
    for (let day = 0; day < 7; day++) {
      const date = addDays(shownWeek, day), column = document.createElement('div'); column.className = 'cal-day' + (date === today() ? ' today-col' : ''); column.style.gridColumn = String(day + 2); column.style.height = rowsTall + 'px';
      for (let h = 0; h <= H1 - H0; h++) { const line = document.createElement('div'); line.className = 'hour-grid-line'; line.style.top = `${h * 56}px`; line.setAttribute('aria-hidden', 'true'); column.append(line); }
      const records = filtered.filter(s => s.date === date).sort((a, b) => a.start - b.start || a.end - b.end);
      const groups = [];
      records.forEach(s => { let group = groups.find(g => g.some(t => s.start < t.end && t.start < s.end)); if (!group) { group = []; groups.push(group); } group.push(s); });
      groups.forEach(group => {
        const lanes = [];
        group.forEach(s => { let lane = lanes.findIndex(t => t <= s.start); if (lane < 0) { lane = lanes.length; lanes.push(s.end); } else lanes[lane] = s.end; s.lane = lane; });
        group.forEach(s => {
          const button = document.createElement('button'), end = Math.min(s.end, H1);
          button.className = 'shift-block' + (s.mine ? ' mine' : '') + (s.open ? ' open' : ''); button.type = 'button';
          button.style.top = `${(s.start - H0) * 56 + 2}px`; button.style.height = `${(end - s.start) * 56 - 4}px`;
          button.style.width = `calc(${100 / lanes.length}% - 4px)`; button.style.left = `calc(${s.lane * 100 / lanes.length}% + 2px)`;
          button.title = `${s.title} · ${span(s.start, s.end)} · ${s.person}`;
          button.setAttribute('aria-label', button.title + '. View details');
          button.innerHTML = `<span class="shift-title">${esc(s.title)}</span><span class="shift-meta">${esc(span(s.start, s.end))} · ${esc(s.person)}</span>`;
          button.onclick = () => openShift(s.id); column.append(button);
        });
      });
      const now = new Date(); const h = now.getHours() + now.getMinutes() / 60;
      if (date === today() && h >= H0 && h <= H1) { const line = document.createElement('div'); line.className = 'now-line'; line.style.top = `${(h - H0) * 56}px`; line.setAttribute('aria-hidden', 'true'); column.append(line); }
      cal.append(column);
    }
    if (weekOf(selectedDay) !== shownWeek) selectedDay = shownWeek;
    renderAgenda(filtered);
  }
  function renderAgenda(list) {
    $('dateStrip').innerHTML = Array.from({length: 7}, (_, i) => { const date = addDays(shownWeek, i); return `<button type="button" class="date-choice numeric" data-agenda-date="${date}" aria-pressed="${date === selectedDay}"><span>${dayName(date)}</span><strong>${parseDate(date).getDate()}</strong></button>`; }).join('');
    $('dateStrip').querySelectorAll('[data-agenda-date]').forEach(b => b.onclick = () => { selectedDay = b.dataset.agendaDate; renderAgenda(list); });
    const dayShifts = list.filter(s => s.date === selectedDay).sort((a, b) => a.start - b.start);
    $('agendaEntries').innerHTML = dayShifts.length ? dayShifts.map(s => `<button class="agenda-shift" data-open-shift="${s.id}"><span class="agenda-time numeric">${esc(shortTime(s.start))}</span><span class="agenda-info"><strong>${esc(s.title)}</strong><small>${esc(span(s.start, s.end))} · ${esc(s.person)}</small></span></button>`).join('') : `<div class="empty agenda-empty">No shifts on ${dayName(selectedDay)}.</div>`;
    $('agendaEntries').querySelectorAll('[data-open-shift]').forEach(b => b.onclick = () => openShift(Number(b.dataset.openShift)));
  }
  function openShift(id) {
    const s = shifts.find(x => x.id === id); if (!s) return; selectedShift = id;
    $('sheetTitle').textContent = s.title; $('sheetDate').textContent = longDay(s.date); $('sheetTime').textContent = span(s.start, s.end); $('sheetPerson').textContent = s.person;
    $('sheetStatus').textContent = s.open ? 'Change requested' : 'Scheduled';
    const why = !s.mine ? 'You can only request changes for your own shifts' : s.open ? 'There is already an open request for this shift' : s.startDt <= nowISO() ? 'This shift has already started' : '';
    $('requestCoverageFromSheet').disabled = !!why; $('requestCoverageFromSheet').title = why;
    openDialog('shiftSheet');
  }
  $('requestCoverageFromSheet').onclick = () => { const id = selectedShift; closeDialog('shiftSheet'); openRequestDialog(id); };
  $('weekPrev').onclick = () => { shownWeek = addDays(shownWeek, -7); selectedDay = shownWeek; renderPage('schedule'); };
  $('weekNext').onclick = () => { shownWeek = addDays(shownWeek, 7); selectedDay = shownWeek; renderPage('schedule'); };
  $('todayButton').onclick = () => { shownWeek = weekOf(today()); selectedDay = today(); renderPage('schedule'); };
  document.querySelectorAll('[data-schedule-filter]').forEach(b => b.onclick = () => { scheduleFilter = b.dataset.scheduleFilter; renderSchedule(); });

  // --- requests ---
  function statusStyle(s) { return s === 'approved' ? 'approved' : s === 'declined' || s === 'canceled' ? 'declined' : 'pending'; }
  const requestTitle = r => r.type === 'swap' ? 'Shift swap' : 'Shift coverage';
  const shiftWhen = (start, end) => `${shortDay(start.slice(0, 10))} · ${span(toHours(start.slice(11)), toHours(end.slice(11)))}`;
  const targetName = r => r.target_name || 'Anyone on the team';
  function renderRequests() {
    Object.keys(boxes).forEach(k => { $(k + 'Count').textContent = boxes[k].length; });
    document.querySelectorAll('[data-tab]').forEach(b => { const chosen = b.dataset.tab === activeTab; b.setAttribute('aria-selected', String(chosen)); b.tabIndex = chosen ? 0 : -1; });
    $('requestsList').setAttribute('aria-labelledby', activeTab + 'Tab');
    const list = boxes[activeTab];
    if (!list.length) { $('requestsList').innerHTML = `<div class="empty">${ICON('inbox')}<span>${{received: 'No requests to review.', sent: 'You have no open requests.', history: 'No completed requests yet.'}[activeTab]}</span></div>`; return; }
    $('requestsList').innerHTML = list.map(r => {
      const open = r.status.startsWith('awaiting_');
      let subtitle = `${esc(r.role_name)} · ${esc(shiftWhen(r.start_dt, r.end_dt))}`;
      if (r.type === 'swap' && r.offered_start_dt) subtitle += ` ⇄ ${esc(shiftWhen(r.offered_start_dt, r.offered_end_dt))}`;
      const fromName = r.requester_id === user.id ? 'You' : r.requester_name;
      const toName = r.target_user_id === user.id ? 'you' : targetName(r);
      const line = `${esc(fromName)} → ${esc(toName)} · ${esc(ago(r.created_at))}`;
      const actions = activeTab === 'received' && r.status === 'awaiting_coworker'
        ? `<div class="row-actions">${r.target_user_id ? `<button type="button" class="button ghost small" data-request-action="decline" data-id="${r.id}">Decline</button>` : ''}<button type="button" class="button small sm-primary" data-request-action="accept" data-id="${r.id}">${r.target_user_id ? 'Accept' : 'Take shift'}</button></div>`
        : activeTab === 'sent' && open ? `<div class="row-actions"><button type="button" class="button ghost small" data-request-action="cancel" data-id="${r.id}">Cancel</button></div>` : '';
      return `<div class="request-row"><div class="request-main" data-detail="${r.id}" role="button" tabindex="0" aria-label="${esc(requestTitle(r))} details"><span class="status-dot ${statusStyle(r.status)}"></span><div><strong>${requestTitle(r)}</strong><p>${subtitle}</p><small>${line}</small></div></div><span class="tag ${statusStyle(r.status)}">${esc(describeStatus(r.status))}</span>${actions}</div>`;
    }).join('');
    $('requestsList').querySelectorAll('[data-request-action]').forEach(b => b.onclick = async () => {
      const action = b.dataset.requestAction;
      const ok = await attempt(() => api(`/requests/${b.dataset.id}/${action}`, {method: 'POST'}), b);
      if (ok) { toast({accept: 'Accepted. A manager will review it next.', decline: 'Request declined.', cancel: 'Request canceled.'}[action]); await refreshAll(); }
    });
    $('requestsList').querySelectorAll('[data-detail]').forEach(el => {
      el.onclick = () => openDetail(Number(el.dataset.detail));
      el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(Number(el.dataset.detail)); } };
    });
  }
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { activeTab = b.dataset.tab; renderRequests(); });
  $('requestTabs').addEventListener('keydown', e => { if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); const arr = [...document.querySelectorAll('[data-tab]')], i = arr.findIndex(b => b.dataset.tab === activeTab); const j = e.key === 'Home' ? 0 : e.key === 'End' ? arr.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + arr.length) % arr.length; activeTab = arr[j].dataset.tab; renderRequests(); arr[j].focus(); });

  async function openDetail(id) {
    let r;
    try { r = await api('/requests/' + id); } catch (e) { toast(e.message); return; }
    $('detailTitle').textContent = requestTitle(r);
    const facts = [['Status', describeStatus(r.status)], ['Shift', `${r.role_name} · ${shiftWhen(r.start_dt, r.end_dt)}`]];
    if (r.type === 'swap' && r.offered_start_dt) facts.push(['In return', shiftWhen(r.offered_start_dt, r.offered_end_dt)]);
    facts.push(['From', r.requester_name], ['To', targetName(r)]);
    $('detailFacts').innerHTML = facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    $('detailTimeline').innerHTML = r.events.map(e => `<li><span><strong>${esc(e.actor_name)}</strong> · ${esc(e.from_status ? describeStatus(e.to_status) : 'Created the request')}</span>${e.note ? `<span class="note">“${esc(e.note)}”</span>` : ''}<small>${esc(ago(e.at))}</small></li>`).join('');
    openDialog('detailDialog');
  }

  // new request dialog: options come from the matching engine, so only eligible people/shifts are offered
  let myShifts = [];
  async function openRequestDialog(preselect) {
    $('requestForm').reset(); showError('requestFormError', '');
    try { myShifts = (await api('/me/shifts')).filter(s => s.workplace_id === wp.id && s.start_dt > nowISO() && !s.open_requests); }
    catch (e) { toast(e.message); return; }
    $('requestShift').innerHTML = myShifts.map(s => `<option value="${s.id}">${esc(s.role_name)} · ${esc(shiftWhen(s.start_dt, s.end_dt))}</option>`).join('');
    if (preselect && myShifts.some(s => s.id === preselect)) $('requestShift').value = String(preselect);
    $('requestForm').querySelector('[type=submit]').disabled = !myShifts.length;
    openDialog('requestDialog');
    if (!myShifts.length) { showError('requestFormError', 'You have no upcoming shifts without an open request.'); $('requestTeammate').innerHTML = ''; $('requestHelp').textContent = ''; return; }
    await loadRequestOptions();
  }
  async function loadRequestOptions() {
    const shiftId = Number($('requestShift').value), kind = $('requestKind').value;
    const submit = $('requestForm').querySelector('[type=submit]');
    $('requestTeammateField').hidden = kind === 'swap'; $('requestOfferedField').hidden = kind !== 'swap';
    showError('requestFormError', ''); $('requestHelp').textContent = 'Checking who can take it…'; submit.disabled = true;
    try {
      if (kind === 'coverage') {
        const {eligible, ineligible} = await api(`/shifts/${shiftId}/coverage`);
        $('requestTeammate').innerHTML = `<option value="">Anyone eligible on the team</option>` +
          eligible.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('') +
          ineligible.map(p => `<option value="${p.id}" disabled>${esc(p.name)} — ${esc(p.reasons.join('; '))}</option>`).join('');
        $('requestHelp').textContent = eligible.length ? `${eligible.length} teammate${eligible.length === 1 ? ' is' : 's are'} trained, available, and free at that time.` : 'Nobody is eligible right now. You can still post it to the team in case availability changes.';
        submit.disabled = false;
      } else {
        const {eligible, ineligible} = await api(`/shifts/${shiftId}/swap-options`);
        $('requestOffered').innerHTML = eligible.map(s => `<option value="${s.id}">${esc(s.assignee_name)} · ${esc(s.role_name)} · ${esc(shiftWhen(s.start_dt, s.end_dt))}</option>`).join('');
        $('requestHelp').textContent = eligible.length ? 'Both of you must be trained, available, and free for the other shift.' : `No shifts can be swapped with this one${ineligible.length ? ` (${ineligible.length} checked)` : ''}.`;
        submit.disabled = !eligible.length;
      }
    } catch (e) { showError('requestFormError', e.message); $('requestHelp').textContent = ''; }
  }
  $('requestShift').onchange = loadRequestOptions;
  $('requestKind').onchange = loadRequestOptions;
  $('newRequestButton').onclick = () => openRequestDialog();
  $('requestForm').onsubmit = async e => {
    e.preventDefault();
    const kind = $('requestKind').value;
    const body = {type: kind, shift_id: Number($('requestShift').value)};
    if (kind === 'coverage') body.target_user_id = $('requestTeammate').value ? Number($('requestTeammate').value) : null;
    else body.offered_shift_id = Number($('requestOffered').value);
    try {
      submitter(e).disabled = true;
      await api('/requests', {method: 'POST', body});
      closeDialog('requestDialog'); toast('Request sent.');
      activeTab = 'sent'; await refreshAll();
      if (location.hash !== '#requests') location.hash = '#requests'; else renderRequests();
    } catch (err) { showError('requestFormError', err.message); }
    finally { submitter(e).disabled = false; }
  };

  // --- manager ---
  let rejecting = null;
  function renderManager() {
    $('inviteCode').textContent = wp.invite_code || '';
    $('managerCount').textContent = pending.length;
    $('managerDecisions').innerHTML = pending.length ? pending.map(d => {
      let when = `${esc(d.role_name)} · ${esc(shiftWhen(d.start_dt, d.end_dt))}`;
      if (d.type === 'swap' && d.offered_start_dt) when += ` ⇄ ${esc(shiftWhen(d.offered_start_dt, d.offered_end_dt))}`;
      return `<div class="decision-row"><div class="decision-main" data-detail="${d.id}" role="button" tabindex="0"><div class="decision-top"><strong>${d.type === 'swap' ? 'Shift swap' : 'Coverage request'}</strong><span class="tag plain">${d.type === 'swap' ? 'Swap' : 'Coverage'}</span></div><p>${when}</p><small class="decision-meta"><span class="tiny-avatars">${avatar(d.requester_name, d.requester_id)}${avatar(d.target_name, d.target_user_id)}</span>${esc(d.original_assignee)} → ${esc(d.proposed_assignee)}</small></div><div class="row-actions"><button class="button secondary small" data-decision="reject" data-id="${d.id}">Reject</button><button class="button approve-button small" data-decision="approve" data-id="${d.id}">Approve</button></div></div>`;
    }).join('') : `<div class="empty">${ICON('check')}<span>No approvals are waiting.</span></div>`;
    $('managerDecisions').querySelectorAll('[data-detail]').forEach(el => el.onclick = () => openDetail(Number(el.dataset.detail)));
    $('managerDecisions').querySelectorAll('[data-decision]').forEach(b => b.onclick = async () => {
      if (b.dataset.decision === 'reject') { rejecting = Number(b.dataset.id); $('rejectForm').reset(); showError('rejectError', ''); openDialog('rejectDialog'); return; }
      // approve re-checks eligibility server side; if it fails there the request is declined and the reason comes back as the error
      const ok = await attempt(() => api(`/requests/${b.dataset.id}/approve`, {method: 'POST'}), b);
      if (ok) toast('Approved. The schedule has been updated.');
      await refreshAll();
    });
    $('peopleCount').textContent = members.length;
    $('peopleList').innerHTML = members.map(p => {
      const missing = roles.filter(r => !p.roles.some(x => x.id === r.id));
      return `<div class="person-row">${avatar(p.name, p.id)}<div class="person-text"><strong>${esc(p.name)}${p.id === user.id ? ' (you)' : ''}</strong><span class="person-roles">${p.roles.map(r => `<span class="tag plain">${esc(r.name)}</span>`).join('') || '<small>No roles yet</small>'}${missing.length ? `<select class="role-add" data-person="${p.id}" aria-label="Give ${esc(p.name)} a role"><option value="">+ Role</option>${missing.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select>` : ''}</span></div>${p.is_manager ? '<span class="tag plain">Manager</span>' : ''}</div>`;
    }).join('');
    $('peopleList').querySelectorAll('[data-person]').forEach(sel => sel.onchange = async () => {
      if (!sel.value) return;
      const ok = await attempt(() => api(`/workplaces/${wp.id}/members/${sel.dataset.person}/roles`, {method: 'POST', body: {role_id: Number(sel.value)}}), sel);
      if (ok) { await loadTeam(); renderManager(); }
    });
    $('rolesList').innerHTML = roles.map(r => `<span class="tag plain">${esc(r.name)}</span>`).join('');
  }
  $('rejectForm').onsubmit = async e => {
    e.preventDefault();
    try {
      await api(`/requests/${rejecting}/reject`, {method: 'POST', body: {note: $('rejectNote').value.trim() || null}});
      closeDialog('rejectDialog'); toast('Request rejected.'); await refreshAll();
    } catch (err) { showError('rejectError', err.message); }
  };
  $('addRoleForm').onsubmit = async e => {
    e.preventDefault();
    const ok = await attempt(() => api(`/workplaces/${wp.id}/roles`, {method: 'POST', body: {name: $('addRoleName').value.trim()}}), submitter(e));
    if (ok) { $('addRoleForm').reset(); await loadTeam(); renderManager(); toast('Role added. Give it to the people trained for it.'); }
  };
  function fillShiftPeople() {
    const roleId = Number($('addShiftRole').value);
    const trained = members.filter(m => m.roles.some(r => r.id === roleId));
    $('addShiftPerson').innerHTML = trained.length ? trained.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('') : '<option value="">Nobody has this role yet</option>';
  }
  $('addShiftButton').onclick = () => {
    $('addShiftForm').reset(); showError('addShiftError', '');
    if (!roles.length) { toast('Add a role first, then give it to your team.'); $('addRoleName').focus(); return; }
    $('addShiftRole').innerHTML = roles.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
    fillShiftPeople();
    $('addShiftDate').value = selectedDay >= today() ? selectedDay : today(); $('addShiftStart').value = '9'; $('addShiftEnd').value = '17';
    openDialog('addShiftDialog');
  };
  $('addShiftRole').onchange = fillShiftPeople;
  $('addShiftForm').onsubmit = async e => {
    e.preventDefault();
    const start = +$('addShiftStart').value, end = +$('addShiftEnd').value, date = $('addShiftDate').value;
    if (end <= start) { showError('addShiftError', 'End time must be after start time.'); return; }
    if (!date) { showError('addShiftError', 'Choose a date.'); return; }
    if (!$('addShiftPerson').value) { showError('addShiftError', 'Give someone this role first (People list).'); return; }
    // midnight end is stored as 00:00 on the next day
    const endDt = end >= 24 ? `${addDays(date, 1)}T00:00` : `${date}T${toHHMM(end)}`;
    try {
      submitter(e).disabled = true;
      await api(`/workplaces/${wp.id}/shifts`, {method: 'POST', body: {role_id: Number($('addShiftRole').value), assignee_id: Number($('addShiftPerson').value), start_dt: `${date}T${toHHMM(start)}`, end_dt: endDt}});
      closeDialog('addShiftDialog'); toast('Shift added to the schedule.');
      shownWeek = weekOf(date); selectedDay = date;
      if (location.hash !== '#schedule') location.hash = '#schedule'; else renderPage('schedule');
    } catch (err) { showError('addShiftError', err.message); }
    finally { submitter(e).disabled = false; }
  };

  // --- availability ---
  // The UI edits one window per weekday; extra windows saved some other way are kept unless that day is edited.
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  let weeklyBase = [];
  async function loadAvailability() {
    saved = await api('/me/availability');
    weeklyBase = DAYS.map((_, i) => {
      const rows = saved.weekly.filter(w => w.weekday === i);
      return rows.length ? {on: true, start: toHours(rows[0].start_time), end: toHours(rows[0].end_time)} : {on: false, start: 9, end: 17};
    });
    resetDraft(); renderAvailability();
  }
  const exceptionsBase = () => saved.exceptions.map(x => ({id: x.id, date: x.date, kind: x.kind, start: toHours(x.start_time), end: toHours(x.end_time)}));
  function resetDraft() { availableDraft = JSON.parse(JSON.stringify(weeklyBase)); exceptionsDraft = exceptionsBase(); setDirty(false); }
  function isDirty() { return JSON.stringify(availableDraft) !== JSON.stringify(weeklyBase) || JSON.stringify(exceptionsDraft) !== JSON.stringify(exceptionsBase()); }
  function setDirty(dirty) { $('dirtyNotice').hidden = !dirty; $('saveAvailability').disabled = !dirty; }
  function optionTimes() { let html = ''; for (let h = 0; h < 24; h += .25) { html += `<option value="${h}">${time(h)}</option>`; } html += '<option value="24">12:00 AM (next day)</option>'; return html; }
  const OPTIONS = optionTimes();
  ['exceptionStart', 'exceptionEnd', 'addShiftStart', 'addShiftEnd'].forEach(id => { $(id).innerHTML = OPTIONS; });
  function renderAvailability() { renderWeekly(); renderExceptions(); setDirty(isDirty()); }
  function renderWeekly() {
    $('weeklyRows').innerHTML = availableDraft.map((row, i) => `<div class="weekly-row ${row.on ? '' : 'off'}" data-weekday="${i}"><span class="weekday">${DAYS[i]}</span><div class="time-container">${row.on ? `<button type="button" class="hours-button" data-edit="${i}" aria-label="Edit ${DAYS[i]} hours">${esc(span(row.start, row.end))}</button><div class="hours-inputs" hidden><select aria-label="${DAYS[i]} start time" data-start="${i}">${OPTIONS}</select><span>–</span><select aria-label="${DAYS[i]} end time" data-end="${i}">${OPTIONS}</select></div>` : '<span class="muted">Unavailable</span>'}</div><button type="button" class="switch" role="switch" aria-label="${DAYS[i]} availability" aria-checked="${row.on}" data-toggle="${i}"><span class="thumb"></span></button></div>`).join('');
    $('weeklyRows').querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => { const i = +b.dataset.toggle; availableDraft[i].on = !availableDraft[i].on; renderWeekly(); setDirty(isDirty()); });
    $('weeklyRows').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { const i = +b.dataset.edit, par = b.parentElement; par.querySelector('.hours-button').hidden = true; const edit = par.querySelector('.hours-inputs'); edit.hidden = false; const start = edit.querySelector('[data-start]'), end = edit.querySelector('[data-end]'); start.value = String(availableDraft[i].start); end.value = String(availableDraft[i].end); start.focus(); });
    $('weeklyRows').querySelectorAll('[data-start],[data-end]').forEach(s => s.onchange = () => { const i = +(s.dataset.start ?? s.dataset.end), par = s.closest('.hours-inputs'), start = +par.querySelector('[data-start]').value, end = +par.querySelector('[data-end]').value; if (end <= start) { toast('End time must be after the start time.'); s.value = String(availableDraft[i][s.dataset.start !== undefined ? 'start' : 'end']); return; } availableDraft[i].start = start; availableDraft[i].end = end; setDirty(isDirty()); par.parentElement.querySelector('.hours-button').textContent = span(start, end); });
    $('weeklyRows').querySelectorAll('.hours-inputs').forEach(el => el.addEventListener('focusout', e => { if (el.contains(e.relatedTarget)) return; setTimeout(() => { if (!el.contains(document.activeElement)) { el.hidden = true; el.parentElement.querySelector('.hours-button').hidden = false; } }, 80); }));
  }
  function renderExceptions() {
    const list = [...exceptionsDraft].sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
    $('exceptionRows').innerHTML = list.length ? list.map(e => { const d = parseDate(e.date); return `<div class="exception-row"><span class="date-chip numeric"><small>${d.toLocaleDateString('en-US', {month: 'short'}).toUpperCase()}</small><strong>${d.getDate()}</strong></span><div class="exception-detail"><strong>${esc(shortDay(e.date))}</strong><small>${esc(span(e.start, e.end))} · ${e.kind === 'unavailable' ? 'Unavailable' : 'Available'}</small></div><span class="tag ${e.kind === 'unavailable' ? 'declined' : 'approved'}">${e.kind === 'unavailable' ? 'Unavailable' : 'Available'}</span><button class="icon-button exception-remove" data-remove-exception="${esc(e.id)}" type="button" aria-label="Remove override for ${esc(shortDay(e.date))}">${ICON('x')}</button></div>`; }).join('') : `<div class="empty">${ICON('calendar')}<span>No date overrides added.</span></div>`;
    $('exceptionRows').querySelectorAll('[data-remove-exception]').forEach(b => b.onclick = () => { exceptionsDraft = exceptionsDraft.filter(x => String(x.id) !== b.dataset.removeException); renderExceptions(); setDirty(isDirty()); });
  }
  $('copyMonday').onclick = () => { for (let i = 1; i < 5; i++) availableDraft[i] = {...availableDraft[0]}; renderWeekly(); setDirty(isDirty()); toast('Monday hours copied to weekdays.'); };
  $('saveAvailability').onclick = async () => {
    if (!isDirty()) return;
    for (const [i, r] of availableDraft.entries()) { if (r.on && r.end <= r.start) { toast(`${DAYS[i]} has an invalid time range.`); return; } }
    const btn = $('saveAvailability'); btn.disabled = true;
    try {
      // weekly: replace the rows of each day that changed
      for (const [i, r] of availableDraft.entries()) {
        if (JSON.stringify(r) === JSON.stringify(weeklyBase[i])) continue;
        for (const row of saved.weekly.filter(w => w.weekday === i)) await api(`/me/availability/weekly/${row.id}`, {method: 'DELETE'});
        if (r.on) await api('/me/availability/weekly', {method: 'POST', body: {weekday: i, start_time: toHHMM(r.start), end_time: toHHMM(r.end)}});
      }
      // exceptions: delete removed ones, add new ones
      const keep = new Set(exceptionsDraft.map(x => x.id));
      for (const x of saved.exceptions) if (!keep.has(x.id)) await api(`/me/availability/exceptions/${x.id}`, {method: 'DELETE'});
      for (const x of exceptionsDraft) if (typeof x.id === 'string') await api('/me/availability/exceptions', {method: 'POST', body: {date: x.date, kind: x.kind, start_time: toHHMM(x.start), end_time: toHHMM(x.end)}});
      toast('Availability saved.');
    } catch (e) { toast(e.message); }
    await loadAvailability();
  };
  $('addExceptionButton').onclick = () => { $('exceptionForm').reset(); $('exceptionDate').value = today(); $('exceptionDate').min = today(); $('exceptionStart').value = '0'; $('exceptionEnd').value = '24'; showError('exceptionFormError', ''); openDialog('exceptionDialog'); };
  $('exceptionForm').onsubmit = e => {
    e.preventDefault();
    const start = +$('exceptionStart').value, end = +$('exceptionEnd').value;
    if (end <= start) { showError('exceptionFormError', 'End time must be after start time.'); return; }
    const date = $('exceptionDate').value; if (!date) return;
    exceptionsDraft.push({id: 'new-' + Date.now(), date, kind: $('exceptionKind').value, start, end});
    renderExceptions(); setDirty(isDirty()); closeDialog('exceptionDialog'); toast('Override added. Save your changes.');
  };

  // --- notifications ---
  function renderNotifications() {
    $('notificationList').innerHTML = notes.items.length ? notes.items.map(n => `<button type="button" class="notif-item ${n.is_read ? '' : 'unread'}" data-link="${esc(n.link || '')}">${esc(n.message)}<small>${esc(ago(n.created_at))}</small></button>`).join('') : '<div class="notif-empty">You\'re all caught up.</div>';
    $('notificationList').querySelectorAll('[data-link]').forEach(b => b.onclick = () => {
      $('notificationMenu').hidden = true;
      const m = b.dataset.link.match(/^\/requests\/(\d+)$/);
      if (m) openDetail(Number(m[1]));
    });
    $('markReadButton').hidden = !notes.unread;
  }
  $('notificationButton').onclick = () => { const show = $('notificationMenu').hidden; $('notificationMenu').hidden = !show; $('notificationButton').setAttribute('aria-expanded', String(show)); };
  $('markReadButton').onclick = async () => { if (await attempt(() => api('/notifications/read', {method: 'POST'}))) { await loadNotifications(); renderNavigation(); } };
  // light polling so new requests and approvals show up without a reload
  setInterval(() => { if (user && wp && !document.hidden) refreshAll().catch(() => {}); }, 30000);

  // --- theme, profile menu, command palette, shortcuts ---
  function applyTheme() { if (theme === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = theme; $('themeName').textContent = theme[0].toUpperCase() + theme.slice(1); }
  applyTheme();
  $('profileButton').onclick = () => { const shown = $('userMenu').hidden; $('userMenu').hidden = !shown; $('profileButton').setAttribute('aria-expanded', String(shown)); };
  $('themeButton').onclick = () => { theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'; try { localStorage.setItem('shiftswap-editorial-theme', theme); } catch (e) {} applyTheme(); };
  $('signoutButton').onclick = () => { $('userMenu').hidden = true; openDialog('signoutDialog'); };
  const commandDefs = [
    {label: 'Team schedule', hint: 'G S', run: () => location.hash = '#schedule'},
    {label: 'Requests', hint: 'G R', run: () => location.hash = '#requests'},
    {label: 'Availability', hint: 'G A', run: () => location.hash = '#availability'},
    {label: 'Manager', hint: 'G M', run: () => location.hash = '#manager', managerOnly: true},
    {label: 'New request', hint: '', run: () => { location.hash = '#requests'; openRequestDialog(); }},
    {label: 'Add exception', hint: '', run: () => { location.hash = '#availability'; $('addExceptionButton').click(); }},
    {label: 'Add shift', hint: '', run: () => { location.hash = '#manager'; setTimeout(() => $('addShiftButton').click(), 200); }, managerOnly: true},
    {label: 'Switch workplace', hint: '', run: () => $('workspaceButton').click()},
  ];
  function renderCommands() { const term = $('commandInput').value.trim().toLowerCase(); commands = commandDefs.filter(c => (!c.managerOnly || wp?.is_manager) && c.label.toLowerCase().includes(term)); commandIndex = Math.min(commandIndex, Math.max(0, commands.length - 1)); $('commandResults').innerHTML = commands.length ? commands.map((c, i) => `<button type="button" class="command-option" role="option" aria-selected="${i === commandIndex}" data-command="${i}">${ICON('search')}<span>${esc(c.label)}</span><small>${esc(c.hint)}</small></button>`).join('') : '<div class="empty command-empty">No matches.</div>';
    $('commandResults').querySelectorAll('[data-command]').forEach(b => b.onclick = () => runCommand(+b.dataset.command)); }
  function runCommand(i) { const c = commands[i]; if (!c) return; closeDialog('commandDialog'); $('commandInput').value = ''; c.run(); }
  function showPalette() { if (!user || !wp) return; commandIndex = 0; $('commandInput').value = ''; renderCommands(); openDialog('commandDialog'); $('commandInput').focus(); }
  $('commandTrigger').onclick = showPalette;
  $('commandInput').oninput = () => { commandIndex = 0; renderCommands(); };
  $('commandInput').onkeydown = e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); commandIndex = (commandIndex + (e.key === 'ArrowDown' ? 1 : -1) + commands.length) % Math.max(1, commands.length); renderCommands(); } else if (e.key === 'Enter') { e.preventDefault(); runCommand(commandIndex); } };
  let awaitingG = false, awaitGTimer = null;
  document.addEventListener('keydown', e => {
    if (!user || !wp) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); showPalette(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && activePage === 'availability') { e.preventDefault(); $('saveAvailability').click(); return; }
    const tag = document.activeElement?.tagName;
    if (e.key === 'Escape') { $('userMenu').hidden = true; $('notificationMenu').hidden = true; closeMobile(); return; }
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || document.querySelector('dialog[open]')) return;
    if (awaitingG) { const page = {s: 'schedule', r: 'requests', a: 'availability', m: 'manager'}[e.key.toLowerCase()]; awaitingG = false; clearTimeout(awaitGTimer); if (page) { e.preventDefault(); location.hash = '#' + page; } return; }
    if (e.key.toLowerCase() === 'g' && !e.metaKey && !e.ctrlKey) { awaitingG = true; awaitGTimer = setTimeout(() => awaitingG = false, 900); }
  });
  $('mainNav').onkeydown = e => { if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); const links = [...$('mainNav').querySelectorAll('.nav-item:not([hidden])')]; let i = links.indexOf(document.activeElement); i = e.key === 'Home' ? 0 : e.key === 'End' ? links.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length; links[i].focus(); };
  document.addEventListener('click', e => {
    if (!$('profileButton').contains(e.target) && !$('userMenu').contains(e.target)) { $('userMenu').hidden = true; $('profileButton').setAttribute('aria-expanded', 'false'); }
    if (!$('notificationButton').contains(e.target) && !$('notificationMenu').contains(e.target)) { $('notificationMenu').hidden = true; $('notificationButton').setAttribute('aria-expanded', 'false'); }
  });
  window.addEventListener('beforeunload', e => { if (activePage === 'availability' && isDirty()) { e.preventDefault(); e.returnValue = ''; } });
  $('privacyLink').onclick = e => { e.preventDefault(); $('legalTitle').textContent = 'Privacy'; $('legalContent').textContent = 'ShiftSwap stores your name, email, a hashed password, your shifts, availability, and requests so your team and managers can coordinate. Coworkers only see whether you are free for a shift, not your actual hours. A full privacy policy must be published before public launch.'; openDialog('legalDialog'); };
  $('termsLink').onclick = e => { e.preventDefault(); $('legalTitle').textContent = 'Terms'; $('legalContent').textContent = 'Shift changes only take effect after a manager of your workplace approves them. Production terms must be reviewed and published by the project team before public launch.'; openDialog('legalDialog'); };

  boot();
})();
