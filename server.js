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
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { user: publicUser(user), expiresAt: Date.now() + SESSION_TTL });
    return sendJson(res, 200, { user: publicUser(user) }, { 'Set-Cookie': `ordo_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${IS_PRODUCTION ? '; Secure' : ''}` });
  }

  const session = getSession(req);
  if (!session) return sendJson(res, 401, { error: 'Необходим вход' });

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    sessions.delete(session.token);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'ordo_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0' });
  }
  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    return sendJson(res, 200, {
      user: session.user, users: db.users.filter(user => user.active).map(publicUser), employees: db.employees,
      tasks: db.tasks, events: db.events, errands: db.errands, presence: db.presence,
      audit: canManage(session) ? db.audit.slice(0, 30) : []
    });
  }

  const routes = [
    { base: '/api/tasks', collection: db.tasks, label: 'Задача', prefix: 'task', payload: taskPayload },
    { base: '/api/events', collection: db.events, label: 'Событие', prefix: 'event', payload: eventPayload },
    { base: '/api/errands', collection: db.errands, label: 'Поручение', prefix: 'errand', payload: errandPayload }
  ];
  for (const route of routes) {
    if (url.pathname === route.base && req.method === 'POST') {
      const body = await readBody(req);
      const item = route.payload(body, { id: uid(route.prefix), creatorId: session.user.id, createdAt: Date.now() });
      route.collection.push(item); audit(session.user.id, 'create', route.prefix, item.id); saveDatabase();
      return sendJson(res, 201, item);
    }
    if (url.pathname.startsWith(`${route.base}/`)) {
      const id = decodeURIComponent(url.pathname.slice(route.base.length + 1));
      const item = findOr404(route.collection, id, route.label);
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        if (!canManage(session) && item.assigneeId !== session.user.id && item.creatorId !== session.user.id) return sendJson(res, 403, { error: 'Недостаточно прав' });
        Object.assign(item, route.payload({ ...item, ...body }, item), { updatedAt: Date.now() });
        audit(session.user.id, 'update', route.prefix, id); saveDatabase(); return sendJson(res, 200, item);
      }
      if (req.method === 'DELETE') {
        if (!canManage(session) && item.creatorId !== session.user.id) return sendJson(res, 403, { error: 'Недостаточно прав' });
        route.collection.splice(route.collection.indexOf(item), 1); audit(session.user.id, 'delete', route.prefix, id); saveDatabase(); return sendJson(res, 200, { ok: true });
      }
    }
  }

  if (url.pathname === '/api/employees' && req.method === 'POST') {
    if (!canManage(session)) return sendJson(res, 403, { error: 'Только директор может добавлять сотрудников' });
    const body = await readBody(req); requireFields(body, ['name', 'position']);
    const employee = { id: uid('emp'), name: clean(body.name), position: clean(body.position), department: clean(body.department), phone: clean(body.phone), email: clean(body.email), status: clean(body.status || 'office') };
    db.employees.push(employee); audit(session.user.id, 'create', 'employee', employee.id); saveDatabase(); return sendJson(res, 201, employee);
  }
  if (url.pathname.startsWith('/api/employees/')) {
    if (!canManage(session)) return sendJson(res, 403, { error: 'Недостаточно прав' });
    const id = decodeURIComponent(url.pathname.slice('/api/employees/'.length));
    const employee = findOr404(db.employees, id, 'Сотрудник');
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      for (const key of ['name', 'position', 'department', 'phone', 'email', 'status']) if (key in body) employee[key] = clean(body[key]);
      audit(session.user.id, 'update', 'employee', id); saveDatabase(); return sendJson(res, 200, employee);
    }
    if (req.method === 'DELETE') {
      db.employees.splice(db.employees.indexOf(employee), 1); audit(session.user.id, 'delete', 'employee', id); saveDatabase(); return sendJson(res, 200, { ok: true });
    }
  }
  if (url.pathname === '/api/presence' && req.method === 'POST') {
    if (session.user.role !== 'assistant' && !canManage(session)) return sendJson(res, 403, { error: 'Недостаточно прав' });
    const body = await readBody(req); requireFields(body, ['value']);
    db.presence = { userId: 'aman', value: clean(body.value).slice(0, 80), note: clean(body.note).slice(0, 240), updatedAt: Date.now() };
    audit(session.user.id, 'update', 'presence', 'aman'); saveDatabase(); return sendJson(res, 200, db.presence);
  }
  return sendJson(res, 404, { error: 'Маршрут не найден' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  let requestPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.resolve(PUBLIC_DIR, `.${requestPath}`);
  if (!filePath.startsWith(`${path.resolve(PUBLIC_DIR)}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Страница не найдена');
  }
  const cache = path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/health') return sendJson(res, 200, { status: 'ok', time: new Date().toISOString() });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    if (!res.headersSent) sendJson(res, error.status || 500, { error: error.status ? error.message : 'Внутренняя ошибка сервера' });
    if (!error.status) console.error(error);
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt < now) sessions.delete(token);
}, 60_000).unref();

server.listen(PORT, HOST, () => console.log(`ORDO Manager запущен: http://${HOST}:${PORT}`));
