'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_TTL = 1000 * 60 * 60 * 12;
const BODY_LIMIT = 1024 * 1024;
const sessions = new Map();

const today = () => new Date().toISOString().slice(0, 10);
const uid = prefix => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const clean = value => String(value ?? '').trim();
const hashPassword = password => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
};
const verifyPassword = (password, stored) => {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

function seedDatabase() {
  const date = today();
  const previousDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return {
    version: 2,
    users: [
      { id: 'director', name: 'Эрлан Атанбекович', role: 'director', title: 'Генеральный директор', email: 'director@ordo.local', passwordHash: hashPassword(process.env.DIRECTOR_PASSWORD || '1234'), active: true },
      { id: 'aman', name: 'Аман Талантбекович', role: 'assistant', title: 'Ассистент генерального директора', email: 'aman@ordo.local', passwordHash: hashPassword(process.env.ASSISTANT_PASSWORD || '1234'), active: true }
    ],
    employees: [
      { id: 'emp_aman', userId: 'aman', name: 'Аман Талантбекович', position: 'Ассистент генерального директора', department: 'Администрация', phone: '', email: 'aman@ordo.local', status: 'online' }
    ],
    tasks: [
      { id: 'task_1', title: 'Подготовить документы к встрече', description: 'Собрать договор, приложение и краткую справку.', category: 'Документы', date, time: '11:30', priority: 'high', status: 'new', assigneeId: 'aman', creatorId: 'director', createdAt: Date.now() },
      { id: 'task_2', title: 'Проверить остатки на складе', description: 'Сверить ключевые позиции с учётной системой.', category: 'Склад', date, time: '09:30', priority: 'medium', status: 'work', assigneeId: 'aman', creatorId: 'director', createdAt: Date.now() },
      { id: 'task_3', title: 'Согласовать график поставок', description: '', category: 'Логистика', date, time: '16:00', priority: 'low', status: 'done', assigneeId: 'aman', creatorId: 'director', createdAt: Date.now() },
      { id: 'task_4', title: 'Передать отчёт по исполнению', description: 'Просроченная тестовая задача для проверки контроля.', category: 'Отчёты', date: previousDate, time: '18:00', priority: 'high', status: 'wait', assigneeId: 'aman', creatorId: 'director', createdAt: Date.now() }
    ],
    events: [
      { id: 'event_1', title: 'Встреча с поставщиком', description: 'Обсуждение условий на следующий квартал.', date, time: '10:00', endTime: '11:00', place: 'Переговорная №1', type: 'meeting', participants: ['director', 'aman'], creatorId: 'director', createdAt: Date.now() },
      { id: 'event_2', title: 'Еженедельное совещание', description: '', date, time: '15:00', endTime: '15:30', place: 'Большая переговорная', type: 'meeting', participants: ['director', 'aman'], creatorId: 'director', createdAt: Date.now() }
    ],
    errands: [
      { id: 'errand_1', title: 'Забрать оригиналы договора', description: 'Контакт у ресепшена.', date, time: '13:00', place: 'БЦ «Нурлы Тау»', priority: 'high', status: 'new', assigneeId: 'aman', creatorId: 'director', createdAt: Date.now() }
    ],
    presence: { userId: 'aman', value: 'В офисе', note: '', updatedAt: Date.now() },
    audit: []
  };
}

function migrateDatabase(value) {
  const fresh = seedDatabase();
  const db = value && typeof value === 'object' ? value : fresh;
  db.version = 2;
  db.users = Array.isArray(db.users) ? db.users : fresh.users;
  db.employees = Array.isArray(db.employees) ? db.employees : fresh.employees;
  db.tasks = Array.isArray(db.tasks) ? db.tasks : [];
  db.events = Array.isArray(db.events) ? db.events : [];
  db.errands = Array.isArray(db.errands) ? db.errands : [];
  db.presence = db.presence || db.status || fresh.presence;
  db.audit = Array.isArray(db.audit) ? db.audit : [];
  for (const user of db.users) {
    if (!user.passwordHash && user.password) {
      user.passwordHash = hashPassword(user.password);
      delete user.password;
    }
    user.active = user.active !== false;
    user.title ||= user.role === 'director' ? 'Генеральный директор' : 'Ассистент директора';
    user.email ||= `${user.id}@ordo.local`;
  }
  return db;
}

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
let db;
try {
  db = fs.existsSync(DATA_FILE) ? migrateDatabase(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))) : seedDatabase();
} catch (error) {
  console.error('Не удалось прочитать базу данных, создана резервная копия:', error.message);
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, `${DATA_FILE}.broken-${Date.now()}`);
  db = seedDatabase();
}

function saveDatabase() {
  const temporary = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(temporary, DATA_FILE);
}
saveDatabase();

function publicUser(user) {
  return { id: user.id, name: user.name, role: user.role, title: user.title, email: user.email };
}
function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('Некорректный JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function getSession(req) {
  const token = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('ordo_session='))?.slice(13);
  const session = token ? sessions.get(token) : null;
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL;
  return { token, ...session };
}
function requireFields(body, fields) {
  for (const field of fields) if (!clean(body[field])) throw Object.assign(new Error(`Заполните поле «${field}»`), { status: 400 });
}
function findOr404(collection, id, label) {
  const item = collection.find(entry => entry.id === id);
  if (!item) throw Object.assign(new Error(`${label} не найден`), { status: 404 });
  return item;
}
function audit(userId, action, entity, entityId) {
  db.audit.unshift({ id: uid('audit'), userId, action, entity, entityId, at: Date.now() });
  db.audit = db.audit.slice(0, 500);
}
function canManage(session) { return session.user.role === 'director'; }
function taskPayload(body, current = {}) {
  requireFields(body, ['title', 'date']);
  return {
    ...current,
    title: clean(body.title).slice(0, 160), description: clean(body.description).slice(0, 2000),
    category: clean(body.category || 'Общее').slice(0, 60), date: clean(body.date), time: clean(body.time),
    priority: ['low', 'medium', 'high'].includes(body.priority) ? body.priority : 'medium',
    status: ['new', 'work', 'wait', 'done'].includes(body.status) ? body.status : 'new',
    assigneeId: clean(body.assigneeId || 'aman')
  };
}
function eventPayload(body, current = {}) {
  requireFields(body, ['title', 'date']);
  return {
    ...current, title: clean(body.title).slice(0, 160), description: clean(body.description).slice(0, 2000),
    date: clean(body.date), time: clean(body.time), endTime: clean(body.endTime), place: clean(body.place).slice(0, 160),
    type: ['meeting', 'call', 'trip', 'other'].includes(body.type) ? body.type : 'meeting',
    participants: Array.isArray(body.participants) ? body.participants.map(clean).filter(Boolean).slice(0, 30) : []
  };
}
function errandPayload(body, current = {}) {
  const base = taskPayload(body, current);
  base.place = clean(body.place).slice(0, 160);
  return base;
}

async function handleApi(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readBody(req);
    const user = db.users.find(item => item.id === clean(body.userId) && item.active);
    if (!user || !verifyPassword(String(body.password || ''), user.passwordHash)) return sendJson(res, 401, { error: 'Неверный пользователь или пароль' });
    const token = crypto.randomBytes(32+^��[h��춻�q�^t<label class="full">Название<input name="title" value="${esc(item.title)}" required maxlength="160"></label><label class="full">Описание<textarea name="description">${esc(item.description)}</textarea></label><label>Тип<select name="type">${Object.entries(labels.eventType).map(([v,l])=>option(v,l,item.type||'meeting')).join('')}</select></label><label>Место<input name="place" value="${esc(item.place)}"></label><label>Дата<input name="date" type="date" value="${item.date||isoToday()}" required></label><label>Начало<input name="time" type="time" value="${item.time||''}"></label><label>Окончание<input name="endTime" type="time" value="${item.endTime||''}"></label><label>Участники<select name="participants" multiple>${state.data.users.map(user=>option(user.id,user.name,item.participants?.includes(user.id)?user.id:'')).join('')}</select></label>`;
  if(type==='employee') fields=`<label class="full">ФИО<input name="name" value="${esc(item.name)}" required></label><label>Должность<input name="position" value="${esc(item.position)}" required></label><label>Подразделение<input name="department" value="${esc(item.department)}"></label><label>Телефон<input name="phone" value="${esc(item.phone)}"></label><label>Email<input name="email" type="email" value="${esc(item.email)}"></label><label>Статус<select name="status">${option('office','В офисе',item.status||'office')}${option('online','На связи',item.status)}${option('away','Вне офиса',item.status)}</select></label>`;
  openModal(`<h2>${editing?'Изменить':'Добавить'} ${config.title}</h2><p>Заполните основные данные и сохраните изменения.</p><form id="entityForm" class="form-grid">${fields}<div class="form-actions full">${editing?`<button type="button" class="button danger" onclick="deleteEntity('${type}','${id}')">Удалить</button>`:''}<button type="button" class="button secondary" onclick="closeModal()">Отмена</button><button class="button primary">Сохранить</button></div></form>`);
  $('#entityForm').addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.target);const body=Object.fromEntries(form.entries());if(type==='event')body.participants=form.getAll('participants');try{await api(`/api/${config.collection}${editing?`/${id}`:''}`,{method:editing?'PATCH':'POST',body:JSON.stringify(body)});closeModal();await refresh();toast(editing?'Изменения сохранены':'Запись создана');}catch(error){toast(error.message,true);}});
};
window.deleteEntity=async(type,id)=>{if(!confirm('Удалить запись без возможности восстановления?'))return;const collection={task:'tasks',event:'events',errand:'errands',employee:'employees'}[type];try{await api(`/api/${collection}/${id}`,{method:'DELETE'});closeModal();await refresh();toast('Запись удалена');}catch(error){toast(error.message,true);}};
window.openPresenceModal=()=>{const p=state.data.presence;openModal(`<h2>Текущий статус</h2><p>Статус виден директору на главном экране.</p><form id="presenceForm" class="form-grid"><label class="full">Где вы сейчас<select name="value">${['В офисе','На встрече','В дороге','На складе','Работаю удалённо','Недоступен'].map(x=>option(x,x,p.value)).join('')}</select></label><label class="full">Комментарий<input name="note" value="${esc(p.note)}" maxlength="240"></label><div class="form-actions full"><button type="button" class="button secondary" onclick="closeModal()">Отмена</button><button class="button primary">Обновить</button></div></form>`);$('#presenceForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/presence',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target).entries()))});closeModal();await refresh();toast('Статус обновлён');}catch(error){toast(error.message,true);}});};

(async()=>{try{await refresh(false);showApp();}catch{showLogin();}})();
