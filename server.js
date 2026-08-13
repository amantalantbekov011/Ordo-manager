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

const APP_TIME_ZONE = process.env.APP_TIME_ZONE || 'Asia/Almaty';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
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
    locations: [
      { id: 'location_hq', name: 'Головной офис', type: 'office', address: '', responsible: '', phone: '', note: '', status: 'active', createdAt: Date.now() },
      { id: 'location_wh1', name: 'Склад №1', type: 'warehouse', address: '', responsible: '', phone: '', note: '', status: 'active', createdAt: Date.now() },
      { id: 'location_wh2', name: 'Склад №2', type: 'warehouse', address: '', responsible: '', phone: '', note: '', status: 'active', createdAt: Date.now() }
    ],
    stores: [
      { id: 'store_1', name: 'Globus', address: 'пр. Чуй, 92', district: 'Центр', agent: 'Бакыт Садыков', supervisor: 'Айбек Омуров', phone: '+996 555 100 200', note: 'Ключевая торговая точка', createdAt: Date.now() },
      { id: 'store_2', name: 'Народный', address: 'ул. Киевская, 104', district: 'Центр', agent: 'Бакыт Садыков', supervisor: 'Айбек Омуров', phone: '+996 555 200 300', note: '', createdAt: Date.now() }
    ],
    products: [
      { id: 'product_1', name: 'Напиток ORDO', category: 'Напитки', variant: 'Классический', note: '', order: 0, createdAt: Date.now() },
      { id: 'product_2', name: 'Напиток ORDO Light', category: 'Напитки', variant: 'Лайм', note: '', order: 1, createdAt: Date.now() }
    ],
    matrix: {
      'store_1:product_1': { status: 'yes', quantity: 12, checkedAt: Date.now(), comment: 'На основной полке', checkedBy: 'director' },
      'store_1:product_2': { status: 'no', quantity: 0, checkedAt: Date.now(), comment: '', checkedBy: 'director' }
    },
    matrixHistory: [],
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
  db.locations = Array.isArray(db.locations) && db.locations.length ? db.locations : fresh.locations;
  db.stores = Array.isArray(db.stores) ? db.stores : fresh.stores;
  db.products = Array.isArray(db.products) ? db.products : fresh.products;
  db.matrix = db.matrix && typeof db.matrix === 'object' ? db.matrix : {};
  db.matrixHistory = Array.isArray(db.matrixHistory) ? db.matrixHistory : [];
  db.products.forEach((product, index) => { if (!Number.isFinite(product.order)) product.order = index; });
  for (const [key, value] of Object.entries(db.matrix)) {
    if (!value || typeof value !== 'object') db.matrix[key] = { status: 'unchecked', quantity: 0, comment: '', checkedAt: 0, checkedBy: '' };
    else {
      if (!['yes', 'no', 'unchecked'].includes(value.status)) value.status = 'unchecked';
      value.quantity = Math.max(0, Number(value.quantity) || 0); value.comment = clean(value.comment).slice(0, 1000);
    }
  }
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
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)); }
function validTime(value) { return !value || /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }
function requireKnownUser(id, label = 'Пользователь') {
  if (!db.users.some(user => user.id === id && user.active)) throw Object.assign(new Error(`${label} не найден`), { status: 400 });
}
function requireKnownLocation(id) {
  if (id && !db.locations.some(location => location.id === id && location.status === 'active')) throw Object.assign(new Error('Объект компании не найден или неактивен'), { status: 400 });
}
function visibleTo(session, item) {
  if (canManage(session)) return true;
  return item.creatorId === session.user.id || item.assigneeId === session.user.id || item.participants?.includes(session.user.id);
}
function taskPayload(body, current = {}) {
  requireFields(body, ['title', 'date']);
  const date = clean(body.date), time = clean(body.time), assigneeId = clean(body.assigneeId || 'aman');
  const locationId = clean(body.locationId);
  if (!validDate(date)) throw Object.assign(new Error('Некорректная дата'), { status: 400 });
  if (!validTime(time)) throw Object.assign(new Error('Некорректное время'), { status: 400 });
  requireKnownUser(assigneeId, 'Исполнитель');
  requireKnownLocation(locationId);
  return {
    ...current,
    title: clean(body.title).slice(0, 160), description: clean(body.description).slice(0, 2000),
    category: clean(body.category || 'Общее').slice(0, 60), date, time,
    resultComment: clean(body.resultComment).slice(0, 2000),
    priority: ['low', 'medium', 'high'].includes(body.priority) ? body.priority : 'medium',
    status: ['new', 'work', 'wait', 'done'].includes(body.status) ? body.status : 'new',
    assigneeId, locationId, customLocation: clean(body.customLocation).slice(0, 160)
  };
}
function eventPayload(body, current = {}) {
  requireFields(body, ['title', 'date']);
  const date = clean(body.date), time = clean(body.time), endTime = clean(body.endTime);
  const locationId = clean(body.locationId); requireKnownLocation(locationId);
  if (!validDate(date)) throw Object.assign(new Error('Некорректная дата'), { status: 400 });
  if (!validTime(time) || !validTime(endTime)) throw Object.assign(new Error('Некорректное время'), { status: 400 });
  if (time && endTime && endTime <= time) throw Object.assign(new Error('Время окончания должно быть позже начала'), { status: 400 });
  const participants = Array.isArray(body.participants) ? [...new Set(body.participants.map(clean).filter(Boolean))].slice(0, 30) : [];
  participants.forEach(id => requireKnownUser(id, 'Участник'));
  return {
    ...current, title: clean(body.title).slice(0, 160), description: clean(body.description).slice(0, 2000),
    date, time, endTime, place: clean(body.place).slice(0, 160),
    type: ['meeting', 'call', 'trip', 'other'].includes(body.type) ? body.type : 'meeting',
    participants, locationId
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
    const visible = collection => collection.filter(item => visibleTo(session, item));
    return sendJson(res, 200, {
      user: session.user, users: db.users.filter(user => user.active).map(publicUser), employees: db.employees,
      locations: db.locations,
      tasks: visible(db.tasks), events: visible(db.events), errands: visible(db.errands), presence: db.presence,
      stores: db.stores, products: db.products.slice().sort((a, b) => a.order - b.order), matrix: db.matrix,
      matrixHistory: db.matrixHistory.slice(0, 100),
      audit: canManage(session) ? db.audit.slice(0, 30) : []
    });
  }

  if (url.pathname === '/api/locations' && req.method === 'POST') {
    if (!canManage(session)) return sendJson(res, 403, { error: 'Только директор может добавлять объекты' });
    const body = await readBody(req); requireFields(body, ['name', 'type']);
    if (!['office', 'warehouse'].includes(body.type)) return sendJson(res, 400, { error: 'Некорректный тип объекта' });
    const location = { id: uid('location'), name: clean(body.name).slice(0, 160), type: body.type, address: clean(body.address).slice(0, 240), responsible: clean(body.responsible).slice(0, 160), phone: clean(body.phone).slice(0, 80), note: clean(body.note).slice(0, 1000), status: body.status === 'inactive' ? 'inactive' : 'active', createdAt: Date.now() };
    db.locations.push(location); audit(session.user.id, 'create', 'location', location.id); saveDatabase(); return sendJson(res, 201, location);
  }
  if (url.pathname.startsWith('/api/locations/')) {
    if (!canManage(session)) return sendJson(res, 403, { error: 'Только директор может изменять объекты' });
    const id = decodeURIComponent(url.pathname.slice('/api/locations/'.length)); const location = findOr404(db.locations, id, 'Объект компании');
    if (req.method === 'PATCH') {
      const body = await readBody(req); for (const key of ['name','address','responsible','phone','note']) if (key in body) location[key]=clean(body[key]).slice(0,key==='note'?1000:240);
      if (body.type && ['office','warehouse'].includes(body.type)) location.type=body.type; if (body.status && ['active','inactive'].includes(body.status)) location.status=body.status;
      location.updatedAt=Date.now(); audit(session.user.id,'update','location',id); saveDatabase(); return sendJson(res,200,location);
    }
  }

  if (url.pathname === '/api/stores' && req.method === 'POST') {
    const body = await readBody(req); requireFields(body, ['name', 'address']);
    const store = { id: uid('store'), name: clean(body.name).slice(0, 160), address: clean(body.address).slice(0, 240), district: clean(body.district).slice(0, 100), agent: clean(body.agent).slice(0, 160), supervisor: clean(body.supervisor).slice(0, 160), phone: clean(body.phone).slice(0, 80), note: clean(body.note).slice(0, 1000), createdAt: Date.now() };
    db.stores.push(store); audit(session.user.id, 'create', 'store', store.id); saveDatabase(); return sendJson(res, 201, store);
  }
  if (url.pathname.startsWith('/api/stores/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/stores/'.length));
    const store = findOr404(db.stores, id, 'Торговая точка');
    if (req.method === 'PATCH') {
      const body = await readBody(req); requireFields({ ...store, ...body }, ['name', 'address']);
      for (const key of ['name', 'address', 'district', 'agent', 'supervisor', 'phone', 'note']) if (key in body) store[key] = clean(body[key]).slice(0, key === 'note' ? 1000 : 240);
      store.updatedAt = Date.now(); audit(session.user.id, 'update', 'store', id); saveDatabase(); return sendJson(res, 200, store);
    }
    if (req.method === 'DELETE') {
      if (!canManage(session)) return sendJson(res, 403, { error: 'Только директор может удалять торговые точки' });
      db.stores.splice(db.stores.indexOf(store), 1); for (const key of Object.keys(db.matrix)) if (key.startsWith(`${id}:`)) delete db.matrix[key];
      audit(session.user.id, 'delete', 'store', id); saveDatabase(); return sendJson(res, 200, { ok: true });
    }
  }
  if (url.pathname === '/api/products' && req.method === 'POST') {
    if (!canManage(session)) return sendJson(res, 403, { error: 'Только директор может управлять продукцией' });
    const body = await readBody(req); requireFields(body, ['name']);
    const product = { id: uid('product'), name: clean(body.name).slice(0, 160), category: clean(body.category).slice(0, 100), variant: clean(body.variant).slice(0, 100), note: clean(body.note).slice(0, 1000), order: db.products.length, createdAt: Date.now() };
    db.products.push(product); audit(session.user.id, 'create', 'product', product.id); saveDatabase(); return sendJson(res, 201, product);
  }
  if (url.pathname.startsWith('/api/products/') && url.pathname !== '/api/products/reorder') {
    if (!canManage(session)) return sendJson(res, 403, { error: 'Только директор может управлять продукцией' });
    const id = decodeURIComponent(url.pathname.slice('/api/products/'.length)); const product = findOr404(db.products, id, 'Продукт');
    if (req.method === 'PATCH') {
      const body = await readBody(req); for (const key of ['name', 'category', 'variant', 'note']) if (key in body) product[key] = clean(body[key]).slice(0, key === 'note' ? 1000 : 160);
      if (Number.isInteger(Number(body.order))) product.order = Math.max(0, Number(body.order));
      audit(session.user.id, 'update', 'product', id); saveDatabase(); return sendJson(res, 200, product);
    }
    if (req.method === 'DELETE') {
      db.products.splice(db.products.indexOf(product), 1); for (const key of Object.keys(db.matrix)) if (key.endsWith(`:${id}`)) delete db.matrix[key];
      audit(session.user.id, 'delete', 'product', id); saveDatabase(); return sendJson(res, 200, { ok: true });
    }
  }
  if (url.pathname === '/api/products/reorder' && req.method === 'POST') {
    if (!canManage(session)) return sendJson(res, 403, { error: 'Недостаточно прав' });
    const body = await readBody(req); if (!Array.isArray(body.ids)) return sendJson(res, 400, { error: 'Некорректный порядок' });
    body.ids.forEach((id, index) => { const product = db.products.find(item => item.id === id); if (product) product.order = index; }); saveDatabase(); return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/matrix' && req.method === 'POST') {
    const body = await readBody(req); requireFields(body, ['storeId', 'productId', 'status']);
    findOr404(db.stores, clean(body.storeId), 'Торговая точка'); findOr404(db.products, clean(body.productId), 'Продукт');
    if (!['yes', 'no', 'unchecked'].includes(body.status)) return sendJson(res, 400, { error: 'Некорректный статус' });
    const key = `${clean(body.storeId)}:${clean(body.productId)}`, previous = db.matrix[key] || { status: 'unchecked' };
    const value = { status: body.status, quantity: Math.max(0, Number(body.quantity) || 0), checkedAt: Date.now(), comment: clean(body.comment).slice(0, 1000), checkedBy: session.user.id };
    db.matrix[key] = value; db.matrixHistory.unshift({ id: uid('history'), storeId: clean(body.storeId), productId: clean(body.productId), oldStatus: previous.status, newStatus: value.status, quantity: value.quantity, comment: value.comment, userId: session.user.id, at: Date.now() }); db.matrixHistory = db.matrixHistory.slice(0, 2000);
    audit(session.user.id, 'update', 'matrix', key); saveDatabase(); return sendJson(res, 200, value);
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
      if (!visibleTo(session, item)) return sendJson(res, 403, { error: 'Недостаточно прав' });
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
    if (session.user.role !== 'assistant') return sendJson(res, 403, { error: 'Только Аман может изменять свой рабочий статус' });
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
  // Entry assets must be revalidated after every deploy. Otherwise a new HTML
  // navigation item can be paired with an old app.js that does not know its route.
  const cache = ['.html', '.js', '.css'].includes(path.extname(filePath)) ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600';
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
