'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const requestedPage = new URLSearchParams(location.search).get('view');
const state = { data: null, page: requestedPage === 'stores' ? 'stores' : 'dashboard', taskFilter: 'all', search: '', calendar: new Date(), storeTab: 'matrix', storeFilters: { agent: '', supervisor: '', district: '', product: '', availability: '' } };
const labels = {
  status: { new: 'Новая', work: 'В работе', wait: 'Ожидает', done: 'Выполнено' },
  priority: { low: 'Низкий', medium: 'Средний', high: 'Высокий' },
  eventType: { meeting: 'Встреча', call: 'Звонок', trip: 'Поездка', other: 'Другое' }
};

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const isoToday = () => new Date().toISOString().slice(0, 10);
const formatDate = value => value ? new Date(`${value}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '—';
const formatFullDate = value => value ? new Date(`${value}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
const initials = name => String(name || '').split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase();
const isOverdue = item => item.status !== 'done' && item.date < isoToday();
const personName = id => state.data?.users.find(user => user.id === id)?.name || state.data?.employees.find(employee => employee.userId === id)?.name || 'Не назначен';

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !path.includes('/login')) showLogin();
    throw new Error(payload.error || 'Ошибка запроса');
  }
  return payload;
}
function toast(message, error = false) {
  const node = $('#toast'); node.textContent = message; node.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.className = 'toast', 2600);
}
async function refresh(render = true) {
  state.data = await api('/api/bootstrap');
  state.data.stores ||= []; state.data.products ||= []; state.data.matrix ||= {}; state.data.matrixHistory ||= [];
  if (render) renderPage();
}
function showLogin() { $('#appView').classList.add('hidden'); $('#loginView').classList.remove('hidden'); }
function showApp() {
  $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden');
  const user = state.data.user;
  $('#sideName').textContent = user.name; $('#sideRole').textContent = user.title;
  $('#sideAvatar').textContent = $('#topAvatar').textContent = initials(user.name);
  $('#reportsNavigation').classList.toggle('hidden', user.role !== 'director');
  $('#navTasksCount').textContent = state.data.tasks.filter(task => task.status !== 'done').length;
  $$('#navigation [data-page]').forEach(item => item.classList.toggle('active', item.dataset.page === state.page));
  renderPage();
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ userId: $('#loginUser').value, password: $('#loginPassword').value }) });
    await refresh(false); showApp(); toast('Вход выполнен');
  } catch (error) { toast(error.message, true); }
});
$('#togglePassword').addEventListener('click', () => { const field = $('#loginPassword'); field.type = field.type === 'password' ? 'text' : 'password'; });
$('#logoutButton').addEventListener('click', async () => { try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } finally { state.data = null; showLogin(); } });
$('#navigation').addEventListener('click', event => {
  const button = event.target.closest('[data-page]'); if (!button) return;
  const page = button.dataset.page;
  if (button.tagName === 'A') return;
  state.page = page; $$('#navigation button').forEach(item => item.classList.toggle('active', item === button));
  $('#sidebar').classList.remove('open'); renderPage();
});
$('#openSidebar').addEventListener('click', () => $('#sidebar').classList.add('open'));
$('#closeSidebar').addEventListener('click', () => $('#sidebar').classList.remove('open'));
$('#quickAdd').addEventListener('click', () => state.page==='stores' ? openStoreModal() : openEntityModal(state.page === 'meetings' || state.page === 'calendar' ? 'event' : state.page === 'errands' ? 'errand' : state.page === 'employees' ? 'employee' : 'task'));
$('#notificationButton').addEventListener('click', () => {
  const overdue=[...(state.data?.tasks||[]),...(state.data?.errands||[])].filter(isOverdue), upcoming=(state.data?.events||[]).filter(x=>x.date>=isoToday()).slice(0,5);
  openModal(`<h2>Уведомления</h2><p>Сроки и ближайшие события.</p><div class="audit-list">${overdue.map(x=>`<div class="audit-row"><i>!</i><div><strong>${esc(x.title)}</strong><span>Просрочено · ${formatFullDate(x.date)}</span></div></div>`).join('')}${upcoming.map(x=>`<div class="audit-row"><i>◫</i><div><strong>${esc(x.title)}</strong><span>${formatFullDate(x.date)} · ${esc(x.time||'')}</span></div></div>`).join('')||empty('Уведомлений нет','Новых событий и нарушений сроков нет')}</div>`);
});
$('#globalSearch').addEventListener('input', event => { state.search = event.target.value.toLowerCase().trim(); renderPage(); });
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#globalSearch').focus(); } if (event.key === 'Escape') closeModal(); });
$('#modal').addEventListener('click', event => { if (event.target.matches('[data-close-modal]')) closeModal(); });

function setHead(title, subtitle, action = '') {
  return `<div class="page-head"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="head-actions">${action}</div></div>`;
}
function button(label, entity, extra = '') { return `<button class="button primary" onclick="openEntityModal('${entity}')">＋ ${label}</button>${extra}`; }
function metric(label, value, icon, hint, className = '') { return `<article class="metric"><div class="metric-top"><span>${label}</span><i class="metric-icon">${icon}</i></div><strong class="${className}">${value}</strong><small>${hint}</small></article>`; }
function taskRow(task, compact = true) {
  const status = isOverdue(task) ? 'overdue' : task.status;
  return `<div class="task-row"><button class="check ${task.status === 'done' ? 'done' : ''}" onclick="cycleTask('${task.id}')">${task.status === 'done' ? '✓' : ''}</button><div><h3>${esc(task.title)}</h3><p>${esc(task.category)} · ${formatDate(task.date)} ${esc(task.time)}</p></div><span class="badge ${status === 'new' ? task.priority : status}">${isOverdue(task) ? 'Просрочено' : labels.status[task.status]}</span>${compact ? '' : `<button class="more" onclick="openEntityModal('task','${task.id}')">•••</button>`}</div>`;
}
function eventRow(event) { return `<div class="event-row"><div class="event-time">${esc(event.time || '—')}<br><small>${formatDate(event.date)}</small></div><div><h3>${esc(event.title)}</h3><p>${esc(event.place || labels.eventType[event.type])}</p></div></div>`; }
function empty(title, text) { return `<div class="empty"><b>${title}</b><span>${text}</span></div>`; }

function renderDashboard() {
  const { tasks, events, errands, presence, user } = state.data;
  const open = tasks.filter(x => x.status !== 'done'); const done = tasks.filter(x => x.status === 'done');
  const overdue = tasks.filter(isOverdue); const completion = tasks.length ? Math.round(done.length / tasks.length * 100) : 0;
  const currentEvents = events.filter(x => x.date >= isoToday()).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  const greeting = new Date().getHours() < 12 ? 'Доброе утро' : new Date().getHours() < 18 ? 'Добрый день' : 'Добрый вечер';
  $('#pageHost').innerHTML = `${setHead(`${greeting}, ${esc(user.name.split(' ')[0])}`, new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }), button('Новая задача', 'task'))}
    <div class="metric-grid">${metric('Активные задачи', open.length, '✓', `${tasks.filter(x => x.status === 'work').length} сейчас в работе`)}${metric('Встречи сегодня', events.filter(x => x.date === isoToday()).length, '◫', `${currentEvents.length} предстоящих`)}${metric('Поручения', errands.filter(x => x.status !== 'done').length, '↗', 'Требуют исполнения')}${metric('Просрочено', overdue.length, '!', overdue.length ? 'Обратите внимание' : 'Всё идёт по плану', overdue.length ? 'bad' : '')}</div>
    <div class="content-grid"><section class="panel"><div class="panel-head"><h2>Текущие задачи</h2><button onclick="goPage('tasks')">Все задачи →</button></div>${open.slice().sort((a,b)=>`${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)).slice(0,6).map(x => taskRow(x)).join('') || empty('Задач нет','Создайте первую задачу')}</section>
    <aside><section class="progress-block"><div class="row"><div><small>Выполнение задач</small><strong>${completion}%</strong></div><small>${done.length} из ${tasks.length}</small></div><div class="progress-track"><i style="width:${completion}%"></i></div></section><section class="panel"><div class="panel-head"><h2>Ближайшие события</h2><button onclick="goPage('calendar')">Календарь →</button></div>${currentEvents.slice(0,4).map(eventRow).join('') || empty('Событий нет','Календарь свободен')}<div class="presence"><i class="dot"></i><div><strong>Мой статус: ${esc(presence.value)}</strong><span>${esc(presence.note || 'Статус обновлён')} · ${new Date(presence.updatedAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</span></div>${user.role === 'assistant' || user.role === 'director' ? `<button class="more" onclick="openPresenceModal()">•••</button>` : ''}</div></section></aside></div>`;
}

function renderTasks() {
  const filtered = state.data.tasks.filter(item => (state.taskFilter === 'all' || (state.taskFilter === 'over' ? isOverdue(item) : item.status === state.taskFilter)) && matches(item));
  $('#pageHost').innerHTML = `${setHead('Задачи', 'Планируйте работу, назначайте исполнителей и контролируйте сроки.', button('Новая задача','task'))}<section class="panel"><div class="toolbar"><div class="filter-group">${[['all','Все'],['new','Новые'],['work','В работе'],['wait','Ожидают'],['done','Выполнены'],['over','Просрочены']].map(([id,label])=>`<button class="${state.taskFilter===id?'active':''}" onclick="setTaskFilter('${id}')">${label}</button>`).join('')}</div><input class="toolbar-search" placeholder="Поиск задач…" oninput="setLocalSearch(this.value)"></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Задача</th><th>Категория</th><th>Срок</th><th>Исполнитель</th><th>Статус</th><th></th></tr></thead><tbody>${filtered.map(task => `<tr><td><strong>${esc(task.title)}</strong><small>${esc(task.description)}</small></td><td>${esc(task.category)}</td><td>${formatDate(task.date)} ${esc(task.time)}</td><td>${esc(personName(task.assigneeId))}</td><td><span class="badge ${isOverdue(task)?'overdue':task.status}">${isOverdue(task)?'Просрочено':labels.status[task.status]}</span></td><td><button class="more" onclick="openEntityModal('task','${task.id}')">•••</button></td></tr>`).join('')}</tbody></table>${filtered.length?'':empty('Ничего не найдено','Измените фильтр или создайте задачу')}</div></section>`;
}
function renderCalendar() {
  const view = state.calendar, year = view.getFullYear(), month = view.getMonth();
  const first = new Date(year, month, 1); const offset = (first.getDay() + 6) % 7; const start = new Date(year, month, 1 - offset);
  const cells = [];
  for (let index=0; index<42; index++) {
    const date = new Date(start); date.setDate(start.getDate()+index); const iso = localIso(date);
    const items = [...state.data.events.filter(x=>x.date===iso).map(x=>({...x,kind:'event'})), ...state.data.tasks.filter(x=>x.date===iso).map(x=>({...x,kind:'task'})), ...state.data.errands.filter(x=>x.date===iso).map(x=>({...x,kind:'errand'}))];
    cells.push(`<div class="calendar-day ${date.getMonth()!==month?'muted':''} ${iso===isoToday()?'today':''}"><b>${date.getDate()}</b>${items.slice(0,3).map(x=>`<span class="cal-item ${x.kind==='task'?'task':x.kind==='errand'?'errand':''}" title="${esc(x.title)}">${esc(x.time)} ${esc(x.title)}</span>`).join('')}</div>`);
  }
  const upcoming = state.data.events.filter(x=>x.date>=isoToday()).sort((a,b)=>`${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)).slice(0,8);
  $('#pageHost').innerHTML = `${setHead('Календарь','Общий график задач, встреч и поездок.',button('Событие','event',`<button class="button secondary" onclick="changeMonth(-1)">←</button><button class="button secondary" onclick="changeMonth(1)">→</button>`))}<div class="calendar-shell"><section class="panel calendar-panel"><div class="panel-head" style="padding:20px 20px 0"><h2>${view.toLocaleDateString('ru-RU',{month:'long',year:'numeric'})}</h2><button onclick="calendarToday()">Сегодня</button></div><div class="calendar-week">${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(x=>`<span>${x}</span>`).join('')}</div><div class="calendar-grid">${cells.join('')}</div></section><aside class="panel"><div class="panel-head"><h2>Ближайшие события</h2></div>${upcoming.map(eventRow).join('')||empty('Событий нет','Добавьте событие')}</aside></div>`;
}
function renderMeetings() {
  const events = state.data.events.filter(matches).sort((a,b)=>`${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  $('#pageHost').innerHTML = `${setHead('Встречи','Переговоры, звонки, совещания и поездки.',button('Новая встреча','event'))}<section class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Событие</th><th>Тип</th><th>Дата и время</th><th>Место</th><th>Участники</th><th></th></tr></thead><tbody>${events.map(item=>`<tr><td><strong>${esc(item.title)}</strong><small>${esc(item.description)}</small></td><td>${labels.eventType[item.type]}</td><td>${formatFullDate(item.date)} · ${esc(item.time)}</td><td>${esc(item.place||'—')}</td><td>${item.participants?.length||0}</td><td><button class="more" onclick="openEntityModal('event','${item.id}')">•••</button></td></tr>`).join('')}</tbody></table>${events.length?'':empty('Встреч нет','Добавьте первую встречу')}</div></section>`;
}
function renderErrands() {
  const items = state.data.errands.filter(matches);
  $('#pageHost').innerHTML = `${setHead('Поручения','Выездные и личные поручения с контролем исполнения.',button('Новое поручение','errand'))}<section class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Поручение</th><th>Адрес</th><th>Срок</th><th>Исполнитель</th><th>Статус</th><th></th></tr></thead><tbody>${items.map(item=>`<tr><td><strong>${esc(item.title)}</strong><small>${esc(item.description)}</small></td><td>${esc(item.place||'—')}</td><td>${formatDate(item.date)} ${esc(item.time)}</td><td>${esc(personName(item.assigneeId))}</td><td><span class="badge ${isOverdue(item)?'overdue':item.status}">${isOverdue(item)?'Просрочено':labels.status[item.status]}</span></td><td><button class="more" onclick="openEntityModal('errand','${item.id}')">•••</button></td></tr>`).join('')}</tbody></table>${items.length?'':empty('Поручений нет','Создайте первое поручение')}</div></section>`;
}
function renderEmployees() {
  const items = state.data.employees.filter(matches); const canEdit = state.data.user.role==='director';
  $('#pageHost').innerHTML = `${setHead('Сотрудники','Команда, контакты и текущая доступность.',canEdit?button('Добавить сотрудника','employee'):'')}<div class="employee-grid">${items.map(item=>`<article class="employee-card"><div class="employee-card-head"><div class="avatar">${initials(item.name)}</div><div><h3>${esc(item.name)}</h3><p>${esc(item.position)}</p></div><button class="more" style="margin-left:auto" ${canEdit?`onclick="openEntityModal('employee','${item.id}')"`:''}>•••</button></div><div class="employee-info"><span><i class="status-dot ${item.status==='away'?'away':''}"></i> ${item.status==='away'?'Вне офиса':'Доступен'}</span><span>◉ ${esc(item.department||'Не указан')}</span><span>✆ ${esc(item.phone||'Не указан')}</span><span>✉ ${esc(item.email||'Не указан')}</span></div></article>`).join('')}</div>`;
}
const matrixLabels = { yes: '✓ Есть', no: '✕ Нет', unchecked: '— Не проверено' };
function matrixValue(storeId, productId) { return state.data.matrix[`${storeId}:${productId}`] || { status: 'unchecked', quantity: 0, comment: '' }; }
function storeMatches(store) {
  const f = state.storeFilters, term = state.search;
  if (f.agent && store.agent !== f.agent || f.supervisor && store.supervisor !== f.supervisor || f.district && store.district !== f.district) return false;
  if (term && ![store.name,store.address,store.agent,store.supervisor,...state.data.products.map(x=>x.name)].some(x=>String(x).toLowerCase().includes(term))) return false;
  if (f.product) { const status=matrixValue(store.id,f.product).status; if (f.availability && status!==f.availability) return false; }
  else if (f.availability && !state.data.products.some(p=>matrixValue(store.id,p.id).status===f.availability)) return false;
  return true;
}
function filterSelect(label, key, values) { return `<label class="matrix-filter">${label}<select onchange="setStoreFilter('${key}',this.value)"><option value="">Все</option>${values.map(x=>option(x,x,state.storeFilters[key])).join('')}</select></label>`; }
function renderStores() {
  const { stores, products, user }=state.data, filtered=stores.filter(storeMatches), f=state.storeFilters;
  const selected=products.find(x=>x.id===f.product), stats=selected?{yes:stores.filter(s=>matrixValue(s.id,selected.id).status==='yes').length,no:stores.filter(s=>matrixValue(s.id,selected.id).status==='no').length,unchecked:stores.filter(s=>matrixValue(s.id,selected.id).status==='unchecked').length}:null;
  const actions=`<button class="button secondary" onclick="openStoreModal()">＋ Добавить торговую точку</button>${user.role==='director'?'<button class="button primary" onclick="openProductModal()">＋ Добавить продукт</button>':''}`;
  const tabs=`<div class="section-tabs"><button class="${state.storeTab==='matrix'?'active':''}" onclick="setStoreTab('matrix')">Матрица продукции</button><button class="${state.storeTab==='list'?'active':''}" onclick="setStoreTab('list')">Список точек</button><button class="${state.storeTab==='products'?'active':''}" onclick="setStoreTab('products')">Продукция</button><button class="${state.storeTab==='history'?'active':''}" onclick="setStoreTab('history')">История</button></div>`;
  const filters=`<div class="matrix-filters">${filterSelect('Агент','agent',[...new Set(stores.map(x=>x.agent).filter(Boolean))])}${filterSelect('Супервайзер','supervisor',[...new Set(stores.map(x=>x.supervisor).filter(Boolean))])}${filterSelect('Район','district',[...new Set(stores.map(x=>x.district).filter(Boolean))])}<label class="matrix-filter">Продукт<select onchange="setStoreFilter('product',this.value)"><option value="">Все</option>${products.map(p=>option(p.id,p.name,f.product)).join('')}</select></label><label class="matrix-filter">Наличие<select onchange="setStoreFilter('availability',this.value)">${option('','Все статусы',f.availability)}${option('no','Только отсутствует',f.availability)}${option('unchecked','Только непроверенные',f.availability)}${option('yes','Есть',f.availability)}</select></label></div>`;
  let content='';
  if(state.storeTab==='list') content=`<section class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>№</th><th>Название</th><th>Адрес</th><th>Агент</th><th>Супервайзер</th><th>Телефон</th><th>Примечание</th><th></th></tr></thead><tbody>${filtered.map((s,i)=>`<tr><td>${i+1}</td><td><button class="text-link" onclick="openStoreReport('${s.id}')">${esc(s.name)}</button></td><td>${esc(s.address)}</td><td>${esc(s.agent||'—')}</td><td>${esc(s.supervisor||'—')}</td><td>${esc(s.phone||'—')}</td><td>${esc(s.note||'—')}</td><td><button class="more" onclick="openStoreModal('${s.id}')">•••</button></td></tr>`).join('')}</tbody></table></div></section>`;
  else if(state.storeTab==='products') content=`<div class="product-grid">${products.map((p,i)=>`<article class="employee-card"><div class="employee-card-head"><div><h3>${esc(p.name)}</h3><p>${esc(p.category)} · ${esc(p.variant||'Без вида')}</p></div>${user.role==='director'?`<button class="more" onclick="openProductModal('${p.id}')">•••</button>`:''}</div><div class="product-actions">${user.role==='director'&&i?`<button onclick="moveProduct('${p.id}',-1)">← Раньше</button>`:''}${user.role==='director'&&i<products.length-1?`<button onclick="moveProduct('${p.id}',1)">Позже →</button>`:''}</div></article>`).join('')}</div>`;
  else if(state.storeTab==='history') content=`<section class="panel"><div class="audit-list">${state.data.matrixHistory.map(h=>`<div class="audit-row"><i>${matrixLabels[h.newStatus][0]}</i><div><strong>${esc(stores.find(s=>s.id===h.storeId)?.name||'Удалённый магазин')} · ${esc(products.find(p=>p.id===h.productId)?.name||'Удалённый продукт')}</strong><span>${matrixLabels[h.oldStatus]} → ${matrixLabels[h.newStatus]} · ${esc(personName(h.userId))}</span><small>${new Date(h.at).toLocaleString('ru-RU')}</small></div></div>`).join('')||empty('История пуста','Изменения появятся после первой проверки')}</div></section>`;
  else content=`${stats?`<div class="metric-grid matrix-report">${metric('Всего магазинов',stores.length,'▦',selected.name)}${metric('Есть',stats.yes,'✓','Покрытие')}${metric('Нет',stats.no,'✕','Требует задачи')}${metric('Не проверено',stats.unchecked,'—',`Покрытие ${stores.length?Math.round(stats.yes/stores.length*100):0}%`)}</div>`:''}<section class="panel matrix-panel"><div class="panel-head"><h2>Матрица продукции по магазинам</h2><small>${filtered.length} точек · ${products.length} продуктов</small></div><div class="matrix-scroll"><table class="matrix-table"><thead><tr><th class="sticky c1">№</th><th class="sticky c2">Магазин</th><th class="sticky c3">Адрес</th><th class="sticky c4">Агент</th><th class="sticky c5">Супервайзер</th>${products.map(p=>`<th title="${esc(p.category)} · ${esc(p.variant)}">${esc(p.name)}</th>`).join('')}</tr></thead><tbody>${filtered.map((s,i)=>`<tr><td class="sticky c1">${i+1}</td><td class="sticky c2"><button class="text-link" onclick="openStoreReport('${s.id}')">${esc(s.name)}</button></td><td class="sticky c3">${esc(s.address)}</td><td class="sticky c4">${esc(s.agent||'—')}</td><td class="sticky c5">${esc(s.supervisor||'—')}</td>${products.map(p=>{const v=matrixValue(s.id,p.id);return `<td><button class="matrix-status ${v.status}" onclick="openMatrixModal('${s.id}','${p.id}')">${matrixLabels[v.status]}</button></td>`}).join('')}</tr>`).join('')}</tbody></table></div><div class="matrix-mobile">${filtered.map(s=>`<article class="store-card"><button class="store-card-title" onclick="openStoreReport('${s.id}')">${esc(s.name)}</button><p>${esc(s.address)}<br>Агент: ${esc(s.agent||'—')} · Супервайзер: ${esc(s.supervisor||'—')}</p>${products.map(p=>{const v=matrixValue(s.id,p.id);return `<button class="mobile-product" onclick="openMatrixModal('${s.id}','${p.id}')"><span>${esc(p.name)}</span><b class="${v.status}">${matrixLabels[v.status]}</b></button>`}).join('')}</article>`).join('')}</div></section>`;
  $('#pageHost').innerHTML=`${setHead('Торговые точки','Контроль представленности продукции по магазинам.',actions)}${tabs}${state.storeTab==='matrix'?filters:''}${content}`;
}
function renderReports() {
  if (state.data.user.role !== 'director') { goPage('dashboard'); return; }
  const tasks = [...state.data.tasks, ...state.data.errands];
  const done = tasks.filter(item => item.status === 'done');
  const active = tasks.filter(item => item.status === 'work');
  const overdue = tasks.filter(isOverdue);
  const completion = tasks.length ? Math.round(done.length / tasks.length * 100) : 0;
  const auditLabels = { create: 'создал(а)', update: 'изменил(а)', delete: 'удалил(а)' };
  const entityLabels = { task: 'задачу', event: 'встречу', errand: 'поручение', employee: 'сотрудника', presence: 'статус' };
  const categories = [...new Set(state.data.tasks.map(item => item.category))];
  $('#pageHost').innerHTML = `${setHead('Отчёты', 'Контроль исполнения задач и поручений ассистента.')}
    <div class="metric-grid">${metric('Всего в контроле', tasks.length, '▥', 'Задачи и поручения')}${metric('Выполнено', done.length, '✓', `${completion}% общего объёма`)}${metric('В работе', active.length, '↻', 'Активное исполнение')}${metric('Просрочено', overdue.length, '!', overdue.length ? 'Требует внимания' : 'Нарушений сроков нет')}</div>
    <div class="content-grid"><section class="panel"><div class="panel-head"><h2>Исполнение по направлениям</h2></div><div class="report-bars">${categories.map(category=>{const list=state.data.tasks.filter(item=>item.category===category);const percent=list.length?Math.round(list.filter(item=>item.status==='done').length/list.length*100):0;return `<div class="report-line"><div><strong>${esc(category)}</strong><span>${list.length} задач · ${percent}% выполнено</span></div><div class="report-track"><i style="width:${percent}%"></i></div></div>`}).join('')||empty('Данных пока нет','Создайте задачи для отчёта')}</div></section>
    <aside class="panel"><div class="panel-head"><h2>Последние действия</h2></div><div class="audit-list">${state.data.audit.slice(0,12).map(entry=>`<div class="audit-row"><i>${initials(personName(entry.userId))}</i><div><strong>${esc(personName(entry.userId))}</strong><span>${auditLabels[entry.action]||entry.action} ${entityLabels[entry.entity]||entry.entity}</span><small>${new Date(entry.at).toLocaleString('ru-RU')}</small></div></div>`).join('')||empty('Действий пока нет','Изменения появятся здесь')}</div></aside></div>`;
}
function renderPage() {
  if (!state.data) return;
  $('#globalSearch').placeholder = state.page === 'stores' ? 'Поиск магазинов, адресов и продукции…' : 'Поиск по задачам и встречам…';
  $('#navTasksCount').textContent = state.data.tasks.filter(task=>task.status!=='done').length;
  ({ dashboard: renderDashboard, tasks: renderTasks, calendar: renderCalendar, meetings: renderMeetings, errands: renderErrands, employees: renderEmployees, stores: renderStores, reports: renderReports }[state.page] || renderDashboard)();
}
function matches(item) { if (!state.search) return true; return Object.values(item).some(value => String(value).toLowerCase().includes(state.search)); }
function localIso(date) { const y=date.getFullYear(),m=String(date.getMonth()+1).padStart(2,'0'),d=String(date.getDate()).padStart(2,'0'); return `${y}-${m}-${d}`; }
window.goPage = page => { state.page=page; $$('#navigation [data-page]').forEach(x=>x.classList.toggle('active',x.dataset.page===page)); renderPage(); };
window.setTaskFilter = value => { state.taskFilter=value; renderTasks(); };
window.setLocalSearch = value => { state.search=value.toLowerCase().trim(); renderTasks(); };
window.changeMonth = amount => { state.calendar.setMonth(state.calendar.getMonth()+amount); renderCalendar(); };
window.calendarToday = () => { state.calendar=new Date(); renderCalendar(); };
window.setStoreTab=value=>{state.storeTab=value;renderStores();};
window.setStoreFilter=(key,value)=>{state.storeFilters[key]=value;renderStores();};
window.openStoreModal=(id='')=>{const s=id?state.data.stores.find(x=>x.id===id):{};openModal(`<h2>${id?'Изменить':'Добавить'} торговую точку</h2><form id="storeForm" class="form-grid"><label class="full">Название<input name="name" required maxlength="160" value="${esc(s.name)}"></label><label class="full">Адрес<input name="address" required value="${esc(s.address)}"></label><label>Район<input name="district" value="${esc(s.district)}"></label><label>Торговый агент<input name="agent" value="${esc(s.agent)}"></label><label>Супервайзер<input name="supervisor" value="${esc(s.supervisor)}"></label><label>Телефон<input name="phone" value="${esc(s.phone)}"></label><label class="full">Примечание<textarea name="note">${esc(s.note)}</textarea></label><div class="form-actions full">${id&&state.data.user.role==='director'?`<button type="button" class="button danger" onclick="deleteStore('${id}')">Удалить</button>`:''}<button type="button" class="button secondary" onclick="closeModal()">Отмена</button><button class="button primary">Сохранить</button></div></form>`);$('#storeForm').addEventListener('submit',async e=>{e.preventDefault();try{await api(`/api/stores${id?`/${id}`:''}`,{method:id?'PATCH':'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target).entries()))});closeModal();await refresh();toast('Торговая точка сохранена');}catch(error){toast(error.message,true);}});};
window.deleteStore=async id=>{if(!confirm('Удалить торговую точку и её отметки?'))return;await api(`/api/stores/${id}`,{method:'DELETE'});closeModal();await refresh();};
window.openProductModal=(id='')=>{const p=id?state.data.products.find(x=>x.id===id):{};openModal(`<h2>${id?'Изменить':'Добавить'} продукт</h2><form id="productForm" class="form-grid"><label class="full">Название продукта<input name="name" required maxlength="160" value="${esc(p.name)}"></label><label>Категория<input name="category" value="${esc(p.category)}"></label><label>Вид / вкус<input name="variant" value="${esc(p.variant)}"></label><label class="full">Примечание<textarea name="note">${esc(p.note)}</textarea></label><div class="form-actions full">${id?`<button type="button" class="button danger" onclick="deleteProduct('${id}')">Удалить</button>`:''}<button type="button" class="button secondary" onclick="closeModal()">Отмена</button><button class="button primary">Сохранить</button></div></form>`);$('#productForm').addEventListener('submit',async e=>{e.preventDefault();try{await api(`/api/products${id?`/${id}`:''}`,{method:id?'PATCH':'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target).entries()))});closeModal();await refresh();toast('Продукт сохранён');}catch(error){toast(error.message,true);}});};
window.deleteProduct=async id=>{if(!confirm('Удалить продукт и все его отметки?'))return;await api(`/api/products/${id}`,{method:'DELETE'});closeModal();await refresh();};
window.moveProduct=async(id,delta)=>{const ids=state.data.products.map(x=>x.id),index=ids.indexOf(id),target=index+delta;if(target<0||target>=ids.length)return;[ids[index],ids[target]]=[ids[target],ids[index]];await api('/api/products/reorder',{method:'POST',body:JSON.stringify({ids})});await refresh();};
window.openMatrixModal=(storeId,productId)=>{const s=state.data.stores.find(x=>x.id===storeId),p=state.data.products.find(x=>x.id===productId),v=matrixValue(storeId,productId);openModal(`<h2>${esc(s.name)} · ${esc(p.name)}</h2><p>Обновите результат последней проверки.</p><form id="matrixForm" class="form-grid"><label class="full">Наличие<select name="status">${option('yes','✓ Есть',v.status)}${option('no','✕ Нет',v.status)}${option('unchecked','— Не проверено',v.status)}</select></label><label>Количество<input type="number" min="0" name="quantity" value="${v.quantity||0}"></label><label>Кто проверил<input value="${esc(personName(v.checkedBy))}" disabled></label><label class="full">Комментарий<textarea name="comment">${esc(v.comment)}</textarea></label><div class="form-actions full">${v.status==='no'?`<button type="button" class="button secondary" onclick="createMatrixTask('${storeId}','${productId}')">Создать задачу</button>`:''}<button type="button" class="button secondary" onclick="closeModal()">Отмена</button><button class="button primary">Сохранить</button></div></form>`);$('#matrixForm').addEventListener('submit',async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target).entries());body.storeId=storeId;body.productId=productId;try{await api('/api/matrix',{method:'POST',body:JSON.stringify(body)});closeModal();await refresh();toast('Отметка сохранена');}catch(error){toast(error.message,true);}});};
window.createMatrixTask=async(storeId,productId)=>{const s=state.data.stores.find(x=>x.id===storeId),p=state.data.products.find(x=>x.id===productId);await api('/api/tasks',{method:'POST',body:JSON.stringify({title:`Обеспечить наличие: ${p.name}`,description:`Магазин: ${s.name}\nАдрес: ${s.address}`,category:'Торговые точки',date:isoToday(),assigneeId:'aman',priority:'high'})});closeModal();await refresh();toast('Задача создана');};
window.openStoreReport=storeId=>{const s=state.data.stores.find(x=>x.id===storeId);openModal(`<h2>${esc(s.name)}</h2><p>${esc(s.address)} · Агент: ${esc(s.agent||'—')} · Супервайзер: ${esc(s.supervisor||'—')}</p><div class="store-report">${state.data.products.map(p=>{const v=matrixValue(s.id,p.id);return `<button class="mobile-product" onclick="openMatrixModal('${s.id}','${p.id}')"><span>${esc(p.name)}<small>${esc(p.category)} · ${v.quantity||0} шт.</small></span><b class="${v.status}">${matrixLabels[v.status]}</b></button>`}).join('')}</div>`);};
window.cycleTask = async id => { const task=state.data.tasks.find(x=>x.id===id); const order=['new','work','wait','done']; try{await api(`/api/tasks/${id}`,{method:'PATCH',body:JSON.stringify({status:order[(order.indexOf(task.status)+1)%order.length]})});await refresh();}catch(error){toast(error.message,true);} };

function openModal(html) { $('#modalContent').innerHTML=html; $('#modal').classList.remove('hidden'); $('#modal').setAttribute('aria-hidden','false'); }
function closeModal() { $('#modal').classList.add('hidden'); $('#modal').setAttribute('aria-hidden','true'); }
window.closeModal=closeModal;
function option(value,label,current){return `<option value="${value}" ${value===current?'selected':''}>${label}</option>`;}
function assigneeOptions(current){return state.data.users.map(user=>option(user.id,user.name,current)).join('');}
window.openEntityModal = (type,id='') => {
  const configs={task:{collection:'tasks',title:'задачу'},event:{collection:'events',title:'встречу'},errand:{collection:'errands',title:'поручение'},employee:{collection:'employees',title:'сотрудника'}};
  const config=configs[type], item=id?state.data[config.collection].find(x=>x.id===id):{}; const editing=Boolean(id);
  let fields='';
  if(type==='task'||type==='errand') fields=`<label class="full">Название<input name="title" value="${esc(item.title)}" required maxlength="160"></label><label class="full">Описание<textarea name="description">${esc(item.description)}</textarea></label>${type==='task'?`<label>Категория<select name="category">${['Общее','Документы','Офис','Склад','Логистика','Гости'].map(x=>option(x,x,item.category)).join('')}</select></label>`:`<label>Адрес<input name="place" value="${esc(item.place)}"></label>`}<label>Исполнитель<select name="assigneeId">${assigneeOptions(item.assigneeId||'aman')}</select></label><label>Дата<input name="date" type="date" value="${item.date||isoToday()}" required></label><label>Время<input name="time" type="time" value="${item.time||''}"></label><label>Приоритет<select name="priority">${Object.entries(labels.priority).map(([v,l])=>option(v,l,item.priority||'medium')).join('')}</select></label><label>Статус<select name="status">${Object.entries(labels.status).map(([v,l])=>option(v,l,item.status||'new')).join('')}</select></label><label class="full">Комментарий о результате<textarea name="resultComment" maxlength="2000">${esc(item.resultComment)}</textarea></label>`;
  if(type==='event') { const selectedParticipants=editing?(item.participants||[]):state.data.users.map(user=>user.id); fields=`<label class="full">Название<input name="title" value="${esc(item.title)}" required maxlength="160"></label><label class="full">Описание<textarea name="description">${esc(item.description)}</textarea></label><label>Тип<select name="type">${Object.entries(labels.eventType).map(([v,l])=>option(v,l,item.type||'meeting')).join('')}</select></label><label>Место<input name="place" value="${esc(item.place)}"></label><label>Дата<input name="date" type="date" value="${item.date||isoToday()}" required></label><label>Начало<input name="time" type="time" value="${item.time||''}"></label><label>Окончание<input name="endTime" type="time" value="${item.endTime||''}"></label><label>Участники<select name="participants" multiple>${state.data.users.map(user=>option(user.id,user.name,selectedParticipants.includes(user.id)?user.id:'')).join('')}</select></label>`; }
  if(type==='employee') fields=`<label class="full">ФИО<input name="name" value="${esc(item.name)}" required></label><label>Должность<input name="position" value="${esc(item.position)}" required></label><label>Подразделение<input name="department" value="${esc(item.department)}"></label><label>Телефон<input name="phone" value="${esc(item.phone)}"></label><label>Email<input name="email" type="email" value="${esc(item.email)}"></label><label>Статус<select name="status">${option('office','В офисе',item.status||'office')}${option('online','На связи',item.status)}${option('away','Вне офиса',item.status)}</select></label>`;
  openModal(`<h2>${editing?'Изменить':'Добавить'} ${config.title}</h2><p>Заполните основные данные и сохраните изменения.</p><form id="entityForm" class="form-grid">${fields}<div class="form-actions full">${editing?`<button type="button" class="button danger" onclick="deleteEntity('${type}','${id}')">Удалить</button>`:''}<button type="button" class="button secondary" onclick="closeModal()">Отмена</button><button class="button primary">Сохранить</button></div></form>`);
  $('#entityForm').addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.target);const body=Object.fromEntries(form.entries());if(type==='event')body.participants=form.getAll('participants');try{await api(`/api/${config.collection}${editing?`/${id}`:''}`,{method:editing?'PATCH':'POST',body:JSON.stringify(body)});closeModal();await refresh();toast(editing?'Изменения сохранены':'Запись создана');}catch(error){toast(error.message,true);}});
};
window.deleteEntity=async(type,id)=>{if(!confirm('Удалить запись без возможности восстановления?'))return;const collection={task:'tasks',event:'events',errand:'errands',employee:'employees'}[type];try{await api(`/api/${collection}/${id}`,{method:'DELETE'});closeModal();await refresh();toast('Запись удалена');}catch(error){toast(error.message,true);}};
window.openPresenceModal=()=>{const p=state.data.presence;openModal(`<h2>Текущий статус</h2><p>Статус виден директору на главном экране.</p><form id="presenceForm" class="form-grid"><label class="full">Где вы сейчас<select name="value">${['В офисе','На встрече','В дороге','На складе','Работаю удалённо','Недоступен'].map(x=>option(x,x,p.value)).join('')}</select></label><label class="full">Комментарий<input name="note" value="${esc(p.note)}" maxlength="240"></label><div class="form-actions full"><button type="button" class="button secondary" onclick="closeModal()">Отмена</button><button class="button primary">Обновить</button></div></form>`);$('#presenceForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/presence',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target).entries()))});closeModal();await refresh();toast('Статус обновлён');}catch(error){toast(error.message,true);}});};

(async()=>{try{await refresh(false);showApp();}catch{showLogin();}})();
