'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStorage } = require('./storage');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const DATABASE_URL = process.env.DATABASE_URL || '';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(DATA_FILE), 'uploads');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_TTL = 1000 * 60 * 60 * 12;
const BODY_LIMIT = 6 * 1024 * 1024;
const FILE_LIMIT = 4 * 1024 * 1024;
const ALLOWED_UPLOADS = new Map([['application/pdf','.pdf'],['image/png','.png'],['image/jpeg','.jpg'],['image/webp','.webp'],['application/vnd.openxmlformats-officedocument.wordprocessingml.document','.docx'],['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.xlsx']]);
const validFileSignature = (mime, bytes) => mime === 'application/pdf' ? bytes.subarray(0,4).toString() === '%PDF' : mime === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : mime === 'image/webp' ? bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' : bytes[0] === 80 && bytes[1] === 75;
const sessions = new Map();
const authAttempts = new Map();

const APP_TIME_ZONE = process.env.APP_TIME_ZONE || 'Asia/Almaty';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const uid = prefix => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const clean = value => String(value ?? '').trim();
const normalizeEmail = value => clean(value).toLowerCase();
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
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
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');

function seedDatabase() {
  const date = today();
  const previousDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const companyId = 'company_ordo';
  return {
    version: 4,
    companies: [
      { id: companyId, name: 'ОРДО Трейд', slug: 'ordo-trade', plan: 'business', status: 'active', phone: '', email: 'director@ordo.local', createdAt: Date.now() }
    ],
    users: [
      { id: 'director', companyId, name: 'Эрлан Атанбекович', role: 'director', title: 'Генеральный директор', email: 'director@ordo.local', passwordHash: hashPassword(process.env.DIRECTOR_PASSWORD || '1234'), active: true },
      { id: 'aman', companyId, name: 'Аман Талантбекович', role: 'assistant', title: 'Ассистент генерального директора', email: 'aman@ordo.local', passwordHash: hashPassword(process.env.ASSISTANT_PASSWORD || '1234'), active: true }
    ],
    employees: [
      { id: 'emp_aman', companyId, userId: 'aman', name: 'Аман Талантбекович', position: 'Ассистент генерального директора', department: 'Администрация', phone: '', email: 'aman@ordo.local', status: 'online' }
    ],
    locations: [
      { id: 'location_hq', companyId, name: 'Головной офис', type: 'head_office', address: '', responsible: '', phone: '', note: '', status: 'active', createdAt: Date.now() },
      { id: 'location_wh1', companyId, name: 'Склад №1', type: 'warehouse', address: '', responsible: '', phone: '', note: '', status: 'active', createdAt: Date.now() },
      { id: 'location_wh2', companyId, name: 'Склад №2', type: 'warehouse', address: '', responsible: '', phone: '', note: '', status: 'active', createdAt: Date.now() }
    ],
    stores: [
      { id: 'store_1', companyId, name: 'Globus', address: 'пр. Чуй, 92', district: 'Центр', agent: 'Бакыт Садыков', supervisor: 'Айбек Омуров', phone: '+996 555 100 200', note: 'Ключевая торговая точка', createdAt: Date.now() },
      { id: 'store_2', companyId, name: 'Народный', address: 'ул. Киевская, 104', district: 'Центр', agent: 'Бакыт Садыков', supervisor: 'Айбек Омуров', phone: '+996 555 200 300', note: '', createdAt: Date.now() }
    ],
    products: [
      { id: 'product_1', companyId, name: 'Напиток ORDO', category: 'Напитки', variant: 'Классический', note: '', order: 0, createdAt: Date.now() },
      { id: 'product_2', companyId, name: 'Напиток ORDO Light', category: 'Напитки', variant: 'Лайм', note: '', order: 1, createdAt: Date.now() }
    ],
    matrix: {
      'store_1:product_1': { status: 'yes', quantity: 12, checkedAt: Date.now(), comment: 'На основной полке', checkedBy: 'director' },
      'store_1:product_2': { status: 'no', quantity: 0, checkedAt: Date.now(), comment: '', checkedBy: 'director' }
    },
    matrixHistory: [],
    tasks: [
      { id: 'task_1', companyId, title: 'Подготовить документы к встрече', description: 'Собрать договор, приложение и краткую справку.', category: 'Документы', date, time: '11:30', priority: 'high', status: 'new', assigneeId: 'aman', creatorId: 'director', createdAt: Date.now() },
      { id: 'task_2', companyId, title: 'Проверить остатки на складе', description: 'Сверить ключевые позиции с учётной системой.', category: 'Склад', date, time: '09:30', priority: 'medium', status: 'work', assigneeId: 'aman', creatorId: 'director', createdAt: Date.now() },
      { id: 'task_3', companyId, title: 'Согласовать график поставок', description: '', category: 'Логистика', date, time: '16:00', priority: 'low', status: 'done', assigneeId: 'aman', creatorId: 'director', createdAt: Date.now() },
      { id: 'task_4', companyId, title: 'Передать отчёт по исполнению', description: 'Просроченная тестовая задача для проверки контроля.', category: 'Отчёты', date: previousDate, time: '18:00', priority: 'high', status: 'wait', assigneeId: 'aman', creatorId: 'director', createdAt: Date.now() }
    ],
    events: [
      { id: 'event_1', companyId, title: 'Встреча с поставщиком', description: 'Обсуждение условий на следующий квартал.', date, time: '10:00', endTime: '11:00', place: 'Переговорная №1', type: 'meeting', participants: ['director', 'aman'], creatorId: 'director', createdAt: Date.now() },
      { id: 'event_2', companyId, title: 'Еженедельное совещание', description: '', date, time: '15:00', endTime: '15:30', place: 'Большая переговорная', type: 'meeting', participants: ['director', 'aman'], creatorId: 'director', createdAt: Date.now() }
    ],
    errands: [
      { id: 'errand_1', companyId, title: 'Забрать оригиналы договора', description: 'Контакт у ресепшена.', date, time: '13:00', place: 'БЦ «Нурлы Тау»', priority: 'high', status: 'new', assigneeId: 'aman', creatorId: 'director', createdAt: Date.now() }
    ],
    presences: [{ companyId, userId: 'aman', value: 'В офисе', note: '', updatedAt: Date.now() }],
    notifications: [],
    sessions: [],
    audit: []
  };
}

function migrateDatabase(value) {
  const fresh = seedDatabase();
  const db = value && typeof value === 'object' ? value : fresh;
  const legacyCompanyId = 'company_ordo';
  db.version = 4;
  db.companies = Array.isArray(db.companies) && db.companies.length ? db.companies : fresh.companies;
  db.users = Array.isArray(db.users) ? db.users : fresh.users;
  db.employees = Array.isArray(db.employees) ? db.employees : fresh.employees;
  db.locations = Array.isArray(db.locations) && db.locations.length ? db.locations : fresh.locations;
  db.stores = Array.isArray(db.stores) ? db.stores : fresh.stores;
  db.products = Array.isArray(db.products) ? db.products : fresh.products;
  db.matrix = db.matrix && typeof db.matrix === 'object' ? db.matrix : {};
  db.matrixHistory = Array.isArray(db.matrixHistory) ? db.matrixHistory : [];
  db.notifications = Array.isArray(db.notifications) ? db.notifications : [];
  db.sessions = Array.isArray(db.sessions) ? db.sessions : [];
  db.presences = Array.isArray(db.presences) ? db.presences : [db.presence || fresh.presences[0]];
  delete db.presence;
  for (const collection of [db.users, db.employees, db.locations, db.stores, db.products, db.tasks || [], db.events || [], db.errands || [], db.matrixHistory, db.audit || [], db.notifications, db.presences]) {
    for (const item of collection) item.companyId ||= legacyCompanyId;
  }
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
  db.audit = Array.isArray(db.audit) ? db.audit : [];
  for (const collection of [db.tasks, db.events, db.errands, db.audit]) for (const item of collection) item.companyId ||= legacyCompanyId;
  for (const user of db.users) {
    if (!user.passwordHash && user.password) {
      user.passwordHash = hashPassword(user.password);
      delete user.password;
    }
    user.active = user.active !== false;
    user.title ||= user.role === 'director' ? 'Генеральный директор' : 'Ассистент директора';
    user.email = clean(user.email || `${user.id}@ordo.local`).toLowerCase();
  }
  return db;
}

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const storage = createStorage({ databaseUrl: DATABASE_URL, dataFile: DATA_FILE });
let db;
try {
  if (fs.existsSync(DATA_FILE)) {
    const stored = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if ((Number(stored.version) || 0) < 3) fs.copyFileSync(DATA_FILE, `${DATA_FILE}.pre-v3-${Date.now()}.backup`);
    db = migrateDatabase(stored);
  } else db = seedDatabase();
} catch (error) {
  console.error('Не удалось прочитать базу данных, создана резервная копия:', error.message);
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, `${DATA_FILE}.broken-${Date.now()}`);
  db = seedDatabase();
}

function applyAutomaticTimestamps(database) {
  const now = Date.now();
  const collections = ['companies', 'users', 'employees', 'locations', 'stores', 'products', 'matrixHistory', 'tasks', 'events', 'errands', 'notifications', 'audit'];
  for (const name of collections) for (const item of database[name] || []) {
    item.createdAt ||= item.at || now;
    item.updatedAt ||= item.createdAt;
    for (const child of [...(item.comments || []), ...(item.attachments || [])]) {
      child.createdAt ||= now;
      child.updatedAt ||= child.createdAt;
    }
  }
  for (const value of Object.values(database.matrix || {})) {
    value.createdAt ||= value.checkedAt || now;
    value.updatedAt ||= value.checkedAt || value.createdAt;
  }
}

async function saveDatabase() {
  applyAutomaticTimestamps(db);
  await storage.save(db);
}

function publicUser(user) {
  return { id: user.id, companyId: user.companyId, name: user.name, role: user.role, title: user.title, email: user.email };
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
  let session = token ? sessions.get(token) : null;
  if (!session && token) {
    const stored = db.sessions.find(item => item.tokenHash === hashToken(token));
    const user = stored && db.users.find(item => item.id === stored.userId && item.companyId === stored.companyId && item.active);
    if (stored && user) session = { user: publicUser(user), expiresAt: stored.expiresAt };
  }
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
  const companyId = db.users.find(user => user.id === userId)?.companyId;
  db.audit.unshift({ id: uid('audit'), companyId, userId, action, entity, entityId, at: Date.now() });
  db.audit = db.audit.slice(0, 500);
}
function canManage(session) { return session.user.role === 'director'; }
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)); }
function validTime(value) { return !value || /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }
function requireKnownUser(id, companyId, label = 'Пользователь') {
  if (!db.users.some(user => user.id === id && user.companyId === companyId && user.active)) throw Object.assign(new Error(`${label} не найден`), { status: 400 });
}
function findCompanyOr404(collection, id, session, label) {
  const item = collection.find(entry => entry.id === id && entry.companyId === session.user.companyId);
  if (!item) throw Object.assign(new Error(`${label} не найден`), { status: 404 });
  return item;
}
function notify(companyId, userId, type, title, message, entityId = '') {
  db.notifications.unshift({ id: uid('notification'), companyId, userId, type, title: clean(title).slice(0, 160), message: clean(message).slice(0, 500), entityId, read: false, createdAt: Date.now() });
  db.notifications = db.notifications.slice(0, 5000);
}
function requireKnownLocation(id, companyId) {
  if (id && !db.locations.some(location => location.id === id && location.companyId === companyId && location.status === 'active')) throw Object.assign(new Error('Объект компании не найден или неактивен'), { status: 400 });
}
function visibleTo(session, item) {
  if (item.companyId !== session.user.companyId) return false;
  if (canManage(session)) return true;
  return item.creatorId === session.user.id || item.assigneeId === session.user.id || item.participants?.includes(session.user.id);
}
function taskPayload(body, current = {}) {
  requireFields(body, ['title', 'date']);
  const date = clean(body.date), time = clean(body.time), assigneeId = clean(body.assigneeId || 'aman');
  const locationId = clean(body.locationId);
  if (!validDate(date)) throw Object.assign(new Error('Некорректная дата'), { status: 400 });
  if (!validTime(time)) throw Object.assign(new Error('Некорректное время'), { status: 400 });
  requireKnownUser(assigneeId, current.companyId, 'Исполнитель');
  requireKnownLocation(locationId, current.companyId);
  return {
    ...current,
    title: clean(body.title).slice(0, 160), description: clean(body.description).slice(0, 2000),
    category: clean(body.category || 'Общее').slice(0, 60), date, time,
    resultComment: clean(body.resultComment).slice(0, 2000),
    priority: ['low', 'medium', 'high', 'urgent'].includes(body.priority) ? body.priority : 'medium',
    status: ['new', 'work', 'wait', 'done'].includes(body.status) ? body.status : 'new',
    assigneeId, locationId, customLocation: clean(body.customLocation).slice(0, 160)
  };
}
function eventPayload(body, current = {}) {
  requireFields(body, ['title', 'date']);
  const date = clean(body.date), time = clean(body.time), endTime = clean(body.endTime);
  const locationId = clean(body.locationId); requireKnownLocation(locationId, current.companyId);
  if (!validDate(date)) throw Object.assign(new Error('Некорректная дата'), { status: 400 });
  if (!validTime(time) || !validTime(endTime)) throw Object.assign(new Error('Некорректное время'), { status: 400 });
  if (time && endTime && endTime <= time) throw Object.assign(new Error('Время окончания должно быть позже начала'), { status: 400 });
  const participants = Array.isArray(body.participants) ? [...new Set(body.participants.map(clean).filter(Boolean))].slice(0, 30) : [];
  participants.forEach(id => requireKnownUser(id, current.companyId, 'Участник'));
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
  const origin = req.headers.origin;
  if (origin && ![`${IS_PRODUCTION ? 'https' : 'http'}://${req.headers.host}`, `http://${req.headers.host}`, `https://${req.headers.host}`].includes(origin)) return sendJson(res, 403, { error: 'Недопустимый источник запроса' });
  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    const body = await readBody(req);
    requireFields(body, ['companyName', 'name', 'phone', 'email', 'password', 'passwordConfirm']);
    const email = normalizeEmail(body.email);
    if (!validEmail(email)) return sendJson(res, 400, { error: 'Укажите корректный e-mail' });
    if (String(body.password).length < 8) return sendJson(res, 400, { error: 'Пароль должен содержать не менее 8 символов' });
    if (body.password !== body.passwordConfirm) return sendJson(res, 400, { error: 'Пароли не совпадают' });
    if (db.users.some(user => user.email === email)) return sendJson(res, 409, { error: 'Пользователь с таким e-mail уже существует' });
    const companyId = uid('company'), userId = uid('user');
    const company = { id: companyId, name: clean(body.companyName).slice(0, 160), slug: `${clean(body.companyName).toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 50) || 'company'}-${companyId.slice(-6)}`, plan: 'start', status: 'active', phone: clean(body.phone).slice(0, 80), email, createdAt: Date.now() };
    const user = { id: userId, companyId, name: clean(body.name).slice(0, 160), role: 'director', title: 'Руководитель / Администратор', email, phone: clean(body.phone).slice(0, 80), passwordHash: hashPassword(String(body.password)), active: true, createdAt: Date.now() };
    db.companies.push(company); db.users.push(user);
    db.locations.push({ id: uid('location'), companyId, name: 'Головной офис', type: 'head_office', address: '', responsible: user.name, phone: user.phone, note: '', status: 'active', createdAt: Date.now() });
    audit(userId, 'create', 'company', companyId); await saveDatabase();
    return sendJson(res, 201, { ok: true, company: { id: company.id, name: company.name }, user: publicUser(user) });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const clientKey = req.socket.remoteAddress || 'unknown', attempt = authAttempts.get(clientKey);
    if (attempt?.blockedUntil > Date.now()) return sendJson(res, 429, { error: 'Слишком много попыток. Повторите вход позже' });
    const body = await readBody(req);
    const identity = normalizeEmail(body.email || body.userId);
    const user = db.users.find(item => (item.email === identity || item.id === identity) && item.active);
    if (!user || !verifyPassword(String(body.password || ''), user.passwordHash)) {
      const failures = (attempt?.failures || 0) + 1; authAttempts.set(clientKey, { failures, blockedUntil: failures >= 10 ? Date.now() + 15 * 60_000 : 0 });
      return sendJson(res, 401, { error: 'Неверный пользователь или пароль' });
    }
    authAttempts.delete(clientKey);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { user: publicUser(user), expiresAt: Date.now() + SESSION_TTL });
    db.sessions.push({ tokenHash: hashToken(token), userId: user.id, companyId: user.companyId, expiresAt: Date.now() + SESSION_TTL, createdAt: Date.now() });
    db.sessions = db.sessions.slice(-5000); await saveDatabase();
    return sendJson(res, 200, { user: publicUser(user) }, { 'Set-Cookie': `ordo_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${IS_PRODUCTION ? '; Secure' : ''}` });
  }

  const session = getSession(req);
  if (!session) return sendJson(res, 401, { error: 'Необходим вход' });

  if (url.pathname.startsWith('/api/attachments/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/attachments/'.length));
    let parent, attachment;
    for (const collection of [db.tasks, db.events, db.errands]) {
      parent = collection.find(item => item.companyId === session.user.companyId && item.attachments?.some(file => file.id === id));
      if (parent) { attachment = parent.attachments.find(file => file.id === id); break; }
    }
    if (!parent || !attachment || !visibleTo(session, parent)) return sendJson(res, 404, { error: 'Вложение не найдено' });
    const filePath = path.join(UPLOAD_DIR, attachment.storageName);
    if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'Файл отсутствует в хранилище' });
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': attachment.mime, 'Content-Length': attachment.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(filePath).pipe(res);
    }
    if (req.method === 'DELETE') {
      if (!canManage(session) && attachment.userId !== session.user.id && parent.creatorId !== session.user.id) return sendJson(res, 403, { error: 'Недостаточно прав' });
      parent.attachments.splice(parent.attachments.indexOf(attachment), 1); fs.unlinkSync(filePath); audit(session.user.id, 'delete', 'attachment', id); await saveDatabase(); return sendJson(res, 200, { ok: true });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    sessions.delete(session.token);
    db.sessions = db.sessions.filter(item => item.tokenHash !== hashToken(session.token)); await saveDatabase();
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'ordo_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0' });
  }
  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    const companyId = session.user.companyId;
    const companyItems = collection => collection.filter(item => item.companyId === companyId);
    const visible = collection => collection.filter(item => visibleTo(session, item)).map(item => ({ ...item, attachments: (item.attachments || []).map(({ storageName, ...file }) => file) }));
    const company = db.companies.find(item => item.id === companyId);
    const companyStores = companyItems(db.stores), storeIds = new Set(companyStores.map(item => item.id));
    const companyProducts = companyItems(db.products), productIds = new Set(companyProducts.map(item => item.id));
    const matrix = Object.fromEntries(Object.entries(db.matrix).filter(([key]) => { const [storeId, productId] = key.split(':'); return storeIds.has(storeId) && productIds.has(productId); }));
    return sendJson(res, 200, {
      company, user: session.user, users: companyItems(db.users).filter(user => user.active).map(publicUser), employees: companyItems(db.employees),
      locations: companyItems(db.locations), tasks: visible(db.tasks), events: visible(db.events), errands: visible(db.errands),
      presence: db.presences.find(item => item.companyId === companyId) || { companyId, userId: '', value: 'Не указан', note: '', updatedAt: Date.now() },
      stores: companyStores, products: companyProducts.slice().sort((a, b) => a.order - b.order), matrix,
      matrixHistory: companyItems(db.matrixHistory).slice(0, 100), notifications: companyItems(db.notifications).filter(item => !item.userId || item.userId === session.user.id).slice(0, 100),
      audit: canManage(session) ? companyItems(db.audit).slice(0, 100) : []
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/change-password') {
    const body = await readBody(req), user = findOr404(db.users, session.user.id, 'Пользователь');
    if (!verifyPassword(String(body.currentPassword || ''), user.passwordHash)) return sendJson(res, 400, { error: 'Текущий пароль указан неверно' });
    if (String(body.newPassword || '').length < 8) return sendJson(res, 400, { error: 'Новый пароль должен содержать не менее 8 символов' });
    if (body.newPassword !== body.newPasswordConfirm) return sendJson(res, 400, { error: 'Новые пароли не совпадают' });
    user.passwordHash = hashPassword(String(body.newPassword)); user.passwordChangedAt = Date.now();
    for (const [token, value] of sessions) if (value.user.id === user.id && token !== session.token) sessions.delete(token);
    db.sessions = db.sessions.filter(item => item.userId !== user.id || item.tokenHash === hashToken(session.token));
    user.updatedAt = Date.now(); audit(user.id, 'update', 'password', user.id); await saveDatabase(); return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/notifications/read') {
    const body = await readBody(req);
    for (const item of db.notifications) if (item.companyId === session.user.companyId && (!body.id || item.id === body.id) && (!item.userId || item.userId === session.user.id)) item.read = true;
    await saveDatabase(); return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/api/locations' && req.method === 'POST') {
    if (!canManage(session)) return sendJson(res, 403, { error: 'Только директор может добавлять объекты' });
    const body = await readBody(req); requireFields(body, ['name', 'type']);
    if (!['head_office', 'office', 'warehouse', 'branch'].includes(body.type)) return sendJson(res, 400, { error: 'Некорректный тип объекта' });
    const location = { id: uid('location'), companyId: session.user.companyId, name: clean(body.name).slice(0, 160), type: body.type, address: clean(body.address).slice(0, 240), responsible: clean(body.responsible).slice(0, 160), phone: clean(body.phone).slice(0, 80), note: clean(body.note).slice(0, 1000), status: body.status === 'inactive' ? 'inactive' : 'active', createdAt: Date.now() };
    db.locations.push(location); audit(session.user.id, 'create', 'location', location.id); await saveDatabase(); return sendJson(res, 201, location);
  }
  if (url.pathname.startsWith('/api/locations/')) {
    if (!canManage(session)) return sendJson(res, 403, { error: 'Только директор может изменять объекты' });
    const id = decodeURIComponent(url.pathname.slice('/api/locations/'.length)); const location = findCompanyOr404(db.locations, id, session, 'Объект компании');
    if (req.method === 'PATCH') {
      const body = await readBody(req); for (const key of ['name','address','responsible','phone','note']) if (key in body) location[key]=clean(body[key]).slice(0,key==='note'?1000:240);
      if (body.type && ['head_office','office','warehouse','branch'].includes(body.type)) location.type=body.type; if (body.status && ['active','inactive'].includes(body.status)) location.status=body.status;
      location.updatedAt=Date.now(); audit(session.user.id,'update','location',id); await saveDatabase(); return sendJson(res,200,location);
    }
  }

  if (url.pathname === '/api/stores' && req.method === 'POST') {
    const body = await readBody(req); requireFields(body, ['name', 'address']);
    const store = { id: uid('store'), companyId: session.user.companyId, name: clean(body.name).slice(0, 160), address: clean(body.address).slice(0, 240), district: clean(body.district).slice(0, 100), agent: clean(body.agent).slice(0, 160), supervisor: clean(body.supervisor).slice(0, 160), phone: clean(body.phone).slice(0, 80), note: clean(body.note).slice(0, 1000), createdAt: Date.now() };
    db.stores.push(store); audit(session.user.id, 'create', 'store', store.id); await saveDatabase(); return sendJson(res, 201, store);
  }
  if (url.pathname.startsWith('/api/stores/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/stores/'.length));
    const store = findCompanyOr404(db.stores, id, session, 'Торговая точка');
    if (req.method === 'PATCH') {
      const body = await readBody(req); requireFields({ ...store, ...body }, ['name', 'address']);
      for (const key of ['name', 'address', 'district', 'agent', 'supervisor', 'phone', 'note']) if (key in body) store[key] = clean(body[key]).slice(0, key === 'note' ? 1000 : 240);
      store.updatedAt = Date.now(); audit(session.user.id, 'update', 'store', id); await saveDatabase(); return sendJson(res, 200, store);
    }
    if (req.method === 'DELETE') {
      if (!canManage(session)) return sendJson(res, 403, { error: 'Только директор может удалять торговые точки' });
      db.stores.splice(db.stores.indexOf(store), 1); for (const key of Object.keys(db.matrix)) if (key.startsWith(`${id}:`)) delete db.matrix[key];
      audit(session.user.id, 'delete', 'store', id); await saveDatabase(); return sendJson(res, 200, { ok: true });
    }
  }
  if (url.pathname === '/api/products' && req.method === 'POST') {
    if (!canManage(session)) return sendJson(res, 403, { error: 'Только директор может управлять продукцией' });
    const body = await readBody(req); requireFields(body, ['name']);
    const product = { id: uid('product'), companyId: session.user.companyId, name: clean(body.name).slice(0, 160), category: clean(body.category).slice(0, 100), variant: clean(body.variant).slice(0, 100), note: clean(body.note).slice(0, 1000), order: db.products.filter(item => item.companyId === session.user.companyId).length, createdAt: Date.now() };
    db.products.push(product); audit(session.user.id, 'create', 'product', product.id); await saveDatabase(); return sendJson(res, 201, product);
  }
  if (url.pathname.startsWith('/api/products/') && url.pathname !== '/api/products/reorder') {
    if (!canManage(session)) return sendJson(res, 403, { error: 'Только директор может управлять продукцией' });
    const id = decodeURIComponent(url.pathname.slice('/api/products/'.length)); const product = findCompanyOr404(db.products, id, session, 'Продукт');
    if (req.method === 'PATCH') {
      const body = await readBody(req); for (const key of ['name', 'category', 'variant', 'note']) if (key in body) product[key] = clean(body[key]).slice(0, key === 'note' ? 1000 : 160);
      if (Number.isInteger(Number(body.order))) product.order = Math.max(0, Number(body.order));
      product.updatedAt = Date.now(); audit(session.user.id, 'update', 'product', id); await saveDatabase(); return sendJson(res, 200, product);
    }
    if (req.method === 'DELETE') {
      db.products.splice(db.products.indexOf(product), 1); for (const key of Object.keys(db.matrix)) if (key.endsWith(`:${id}`)) delete db.matrix[key];
      audit(session.user.id, 'delete', 'product', id); await saveDatabase(); return sendJson(res, 200, { ok: true });
    }
  }
  if (url.pathname === '/api/products/reorder' && req.method === 'POST') {
    if (!canManage(session)) return sendJson(res, 403, { error: 'Недостаточно прав' });
    const body = await readBody(req); if (!Array.isArray(body.ids)) return sendJson(res, 400, { error: 'Некорректный порядок' });
    body.ids.forEach((id, index) => { const product = db.products.find(item => item.id === id && item.companyId === session.user.companyId); if (product) { product.order = index; product.updatedAt = Date.now(); } }); await saveDatabase(); return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/matrix' && req.method === 'POST') {
    const body = await readBody(req); requireFields(body, ['storeId', 'productId', 'status']);
    findCompanyOr404(db.stores, clean(body.storeId), session, 'Торговая точка'); findCompanyOr404(db.products, clean(body.productId), session, 'Продукт');
    if (!['yes', 'no', 'unchecked'].includes(body.status)) return sendJson(res, 400, { error: 'Некорректный статус' });
    const key = `${clean(body.storeId)}:${clean(body.productId)}`, previous = db.matrix[key] || { status: 'unchecked' };
    const value = { status: body.status, quantity: Math.max(0, Number(body.quantity) || 0), checkedAt: Date.now(), comment: clean(body.comment).slice(0, 1000), checkedBy: session.user.id };
    db.matrix[key] = value; db.matrixHistory.unshift({ id: uid('history'), companyId: session.user.companyId, storeId: clean(body.storeId), productId: clean(body.productId), oldStatus: previous.status, newStatus: value.status, quantity: value.quantity, comment: value.comment, userId: session.user.id, at: Date.now() }); db.matrixHistory = db.matrixHistory.slice(0, 2000);
    audit(session.user.id, 'update', 'matrix', key); await saveDatabase(); return sendJson(res, 200, value);
  }

  const routes = [
    { base: '/api/tasks', collection: db.tasks, label: 'Задача', prefix: 'task', payload: taskPayload },
    { base: '/api/events', collection: db.events, label: 'Событие', prefix: 'event', payload: eventPayload },
    { base: '/api/errands', collection: db.errands, label: 'Поручение', prefix: 'errand', payload: errandPayload }
  ];
  for (const route of routes) {
    if (req.method === 'POST' && url.pathname.startsWith(`${route.base}/`) && url.pathname.endsWith('/attachments')) {
      const id = decodeURIComponent(url.pathname.slice(route.base.length + 1, -'/attachments'.length));
      const item = findCompanyOr404(route.collection, id, session, route.label);
      if (!visibleTo(session, item)) return sendJson(res, 403, { error: 'Недостаточно прав' });
      const body = await readBody(req), mime = clean(body.mime), extension = ALLOWED_UPLOADS.get(mime), name = path.basename(clean(body.name)).slice(0, 180);
      if (!extension || !name || typeof body.data !== 'string') return sendJson(res, 400, { error: 'Недопустимый формат файла' });
      let bytes; try { bytes = Buffer.from(body.data, 'base64'); } catch { return sendJson(res, 400, { error: 'Файл повреждён' }); }
      if (!bytes.length || bytes.length > FILE_LIMIT) return sendJson(res, 413, { error: 'Размер файла должен быть не более 4 МБ' });
      if (!validFileSignature(mime, bytes)) return sendJson(res, 400, { error: 'Содержимое файла не соответствует заявленному формату' });
      const attachmentId = uid('attachment'), storageName = `${session.user.companyId}-${attachmentId}${extension}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, storageName), bytes, { flag: 'wx' }); item.attachments ||= [];
      const attachment = { id: attachmentId, name, mime, size: bytes.length, storageName, userId: session.user.id, createdAt: Date.now() };
      item.attachments.push(attachment); item.updatedAt = Date.now(); audit(session.user.id, 'create', 'attachment', attachmentId); await saveDatabase();
      return sendJson(res, 201, { ...attachment, storageName: undefined });
    }
    if (req.method === 'POST' && url.pathname.startsWith(`${route.base}/`) && url.pathname.endsWith('/comments')) {
      const id = decodeURIComponent(url.pathname.slice(route.base.length + 1, -'/comments'.length));
      const item = findCompanyOr404(route.collection, id, session, route.label);
      if (!visibleTo(session, item)) return sendJson(res, 403, { error: 'Недостаточно прав' });
      const body = await readBody(req); requireFields(body, ['text']); item.comments ||= [];
      const comment = { id: uid('comment'), userId: session.user.id, text: clean(body.text).slice(0, 2000), createdAt: Date.now() };
      item.comments.push(comment); item.updatedAt = Date.now(); audit(session.user.id, 'comment', route.prefix, id); await saveDatabase(); return sendJson(res, 201, comment);
    }
    if (url.pathname === route.base && req.method === 'POST') {
      const body = await readBody(req);
      const item = route.payload(body, { id: uid(route.prefix), companyId: session.user.companyId, creatorId: session.user.id, comments: [], attachments: [], createdAt: Date.now() });
      route.collection.push(item); audit(session.user.id, 'create', route.prefix, item.id);
      if (item.assigneeId && item.assigneeId !== session.user.id) notify(session.user.companyId, item.assigneeId, 'assignment', 'Новая задача', item.title, item.id);
      await saveDatabase();
      return sendJson(res, 201, item);
    }
    if (url.pathname.startsWith(`${route.base}/`)) {
      const id = decodeURIComponent(url.pathname.slice(route.base.length + 1));
      const item = findCompanyOr404(route.collection, id, session, route.label);
      if (!visibleTo(session, item)) return sendJson(res, 403, { error: 'Недостаточно прав' });
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        if (!canManage(session) && item.assigneeId !== session.user.id && item.creatorId !== session.user.id) return sendJson(res, 403, { error: 'Недостаточно прав' });
        const oldStatus = item.status; Object.assign(item, route.payload({ ...item, ...body }, item), { updatedAt: Date.now() });
        audit(session.user.id, 'update', route.prefix, id);
        if (oldStatus && oldStatus !== item.status) notify(session.user.companyId, item.creatorId, 'status', 'Изменён статус', `${item.title}: ${oldStatus} → ${item.status}`, item.id);
        item.updatedAt = Date.now(); await saveDatabase(); return sendJson(res, 200, item);
      }
      if (req.method === 'DELETE') {
        if (!canManage(session) && item.creatorId !== session.user.id) return sendJson(res, 403, { error: 'Недостаточно прав' });
        route.collection.splice(route.collection.indexOf(item), 1); audit(session.user.id, 'delete', route.prefix, id); await saveDatabase(); return sendJson(res, 200, { ok: true });
      }
    }
  }

  if (url.pathname === '/api/employees' && req.method === 'POST') {
    if (!canManage(session)) return sendJson(res, 403, { error: 'Только директор может добавлять сотрудников' });
    const body = await readBody(req); requireFields(body, ['name', 'position']);
    const company = db.companies.find(item => item.id === session.user.companyId), currentUsers = db.users.filter(item => item.companyId === session.user.companyId && item.active);
    if (company?.plan === 'start' && currentUsers.length >= 2) return sendJson(res, 403, { error: 'Тариф START поддерживает руководителя и одного сотрудника' });
    const email = normalizeEmail(body.email); let userId = '';
    if (email) {
      if (!validEmail(email)) return sendJson(res, 400, { error: 'Некорректный e-mail сотрудника' });
      if (db.users.some(user => user.email === email)) return sendJson(res, 409, { error: 'Пользователь с таким e-mail уже существует' });
      if (String(body.password || '').length < 8) return sendJson(res, 400, { error: 'Для кабинета сотрудника задайте пароль не короче 8 символов' });
      userId = uid('user'); db.users.push({ id: userId, companyId: session.user.companyId, name: clean(body.name), role: 'assistant', title: clean(body.position), email, phone: clean(body.phone), passwordHash: hashPassword(String(body.password)), active: true, createdAt: Date.now() });
    }
    const employee = { id: uid('emp'), companyId: session.user.companyId, userId, name: clean(body.name), position: clean(body.position), department: clean(body.department), phone: clean(body.phone), email, status: clean(body.status || 'office') };
    db.employees.push(employee); audit(session.user.id, 'create', 'employee', employee.id); await saveDatabase(); return sendJson(res, 201, employee);
  }
  if (url.pathname.startsWith('/api/employees/')) {
    if (!canManage(session)) return sendJson(res, 403, { error: 'Недостаточно прав' });
    const id = decodeURIComponent(url.pathname.slice('/api/employees/'.length));
    const employee = findCompanyOr404(db.employees, id, session, 'Сотрудник');
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      for (const key of ['name', 'position', 'department', 'phone', 'email', 'status']) if (key in body) employee[key] = clean(body[key]);
      employee.updatedAt = Date.now(); audit(session.user.id, 'update', 'employee', id); await saveDatabase(); return sendJson(res, 200, employee);
    }
    if (req.method === 'DELETE') {
      const user = db.users.find(item => item.id === employee.userId && item.companyId === session.user.companyId); if (user) user.active = false;
      db.employees.splice(db.employees.indexOf(employee), 1); audit(session.user.id, 'delete', 'employee', id); await saveDatabase(); return sendJson(res, 200, { ok: true });
    }
  }
  if (url.pathname === '/api/presence' && req.method === 'POST') {
    if (session.user.role !== 'assistant') return sendJson(res, 403, { error: 'Только сотрудник может изменять свой рабочий статус' });
    const body = await readBody(req); requireFields(body, ['value']);
    let presence = db.presences.find(item => item.companyId === session.user.companyId && item.userId === session.user.id);
    if (!presence) { presence = { companyId: session.user.companyId, userId: session.user.id }; db.presences.push(presence); }
    Object.assign(presence, { value: clean(body.value).slice(0, 80), note: clean(body.note).slice(0, 240), updatedAt: Date.now() });
    audit(session.user.id, 'update', 'presence', session.user.id); await saveDatabase(); return sendJson(res, 200, presence);
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
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
  fs.createReadStream(filePath).pipe(res);
}

async function initializeStorage() {
  await storage.init();
  const cloudState = await storage.load();
  if (cloudState && (Number(cloudState.version) || 0) < 4) await storage.backup('pre-v4-migration');
  if (cloudState) db = migrateDatabase(cloudState);
  applyAutomaticTimestamps(db);
  await storage.save(db);
  if (DATABASE_URL && !cloudState) {
    const verified = await storage.load();
    const collections = ['companies', 'users', 'employees', 'locations', 'stores', 'products', 'tasks', 'events', 'errands', 'notifications', 'audit'];
    const valid = verified && verified.version === db.version && collections.every(name => (verified[name] || []).length === (db[name] || []).length);
    if (!valid) throw new Error('PostgreSQL migration verification failed; source JSON was not modified');
    await storage.backup('verified-initial-import');
  }
  if (typeof storage.ensureDailyBackup === 'function') await storage.ensureDailyBackup();
  console.log(`ORDO storage ready: ${DATABASE_URL ? 'postgresql' : 'json-test'}`);
}
const storageReady = initializeStorage();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    await storageReady;
    if (url.pathname === '/health') return sendJson(res, 200, { status: 'ok', time: new Date().toISOString(), storage: await storage.health() });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    if (!res.headersSent) sendJson(res, error.status || 500, { error: error.status ? error.message : 'Внутренняя ошибка сервера' });
    if (!error.status) console.error(error);
  }
});

setInterval(async () => {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt < now) sessions.delete(token);
  const count = db.sessions.length; db.sessions = db.sessions.filter(session => session.expiresAt >= now); if (db.sessions.length !== count) await saveDatabase();
}, 60_000).unref();

server.listen(PORT, HOST, () => console.log(`ORDO Manager запущен: http://${HOST}:${PORT}`));
