'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = 32187;
const base = `http://127.0.0.1:${port}`;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordo-test-'));
let server;
let cookie = '';

async function request(url, options = {}) {
  const response = await fetch(`${base}${url}`, { ...options, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) } });
  const value = await response.json();
  return { response, value };
}

test.before(async () => {
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_FILE: path.join(temp, 'db.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Сервер не запустился')), 5000);
    server.stdout.on('data', chunk => { if (chunk.toString().includes('ORDO Manager')) { clearTimeout(timer); resolve(); } });
    server.on('exit', code => reject(new Error(`Сервер завершился с кодом ${code}`)));
  });
});

test.after(() => {
  if (server) server.kill();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('health endpoint отвечает', async () => {
  const { response, value } = await request('/health');
  assert.equal(response.status, 200);
  assert.equal(value.status, 'ok');
});

test('сервер отдаёт интерфейс и статические ресурсы', async () => {
  const html = await fetch(`${base}/`);
  const css = await fetch(`${base}/styles.css`);
  const js = await fetch(`${base}/app.js`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /ORDO Manager/);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.match(js.headers.get('cache-control'), /no-store/);
  const currentHtml = await (await fetch(`${base}/`)).text();
  assert.match(currentHtml, /data-page="stores"/);
  assert.match(currentHtml, /app\.js\?v=[^"']+/);
  assert.match(await (await fetch(`${base}/app.js`)).text(), /stores: renderStores/);
});

test('закрытый API требует авторизацию', async () => {
  const { response } = await request('/api/bootstrap');
  assert.equal(response.status, 401);
});

test('авторизация и загрузка портала', async () => {
  const { response, value } = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ userId: 'director', password: '1234' }) });
  assert.equal(response.status, 200);
  assert.equal(value.user.role, 'director');
  cookie = response.headers.get('set-cookie').split(';')[0];
  const bootstrap = await request('/api/bootstrap');
  assert.equal(bootstrap.response.status, 200);
  assert.ok(bootstrap.value.tasks.length >= 3);
  assert.equal(bootstrap.value.user.name, 'Эрлан Атанбекович');
  assert.equal(bootstrap.value.user.title, 'Генеральный директор');
  assert.equal(bootstrap.value.employees.length, 1);
  assert.equal(bootstrap.value.employees[0].name, 'Аман Талантбекович');
  assert.ok(bootstrap.value.tasks.some(item => item.status === 'done'));
  assert.ok(bootstrap.value.tasks.some(item => item.status !== 'done' && item.date < new Date().toISOString().slice(0, 10)));
});

test('создание, изменение и удаление задачи', async () => {
  const created = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Тестовая задача', date: '2026-08-12', assigneeId: 'aman', priority: 'high' }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.value.title, 'Тестовая задача');
  const changed = await request(`/api/tasks/${created.value.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  assert.equal(changed.value.status, 'done');
  const removed = await request(`/api/tasks/${created.value.id}`, { method: 'DELETE' });
  assert.equal(removed.value.ok, true);
});

test('создание встречи, поручения и сотрудника', async () => {
  const meeting = await request('/api/events', { method: 'POST', body: JSON.stringify({ title: 'Тестовая встреча', date: '2026-08-13', type: 'meeting' }) });
  const errand = await request('/api/errands', { method: 'POST', body: JSON.stringify({ title: 'Тестовое поручение', date: '2026-08-13', place: 'Офис' }) });
  const employee = await request('/api/employees', { method: 'POST', body: JSON.stringify({ name: 'Тестовый Сотрудник', position: 'Специалист' }) });
  assert.equal(meeting.response.status, 201);
  assert.equal(errand.response.status, 201);
  assert.equal(employee.response.status, 201);
});

test('поручение директора синхронизируется с кабинетом ассистента', async () => {
  const directorCookie = cookie;
  const created = await request('/api/errands', { method: 'POST', body: JSON.stringify({ title: 'Поручение от Эрлана', description: 'Сквозной тест двух кабинетов', date: '2026-08-14', assigneeId: 'aman', status: 'new' }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.value.assigneeId, 'aman');

  cookie = '';
  const assistantLogin = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ userId: 'aman', password: '1234' }) });
  assert.equal(assistantLogin.value.user.name, 'Аман Талантбекович');
  assert.equal(assistantLogin.value.user.role, 'assistant');
  cookie = assistantLogin.response.headers.get('set-cookie').split(';')[0];
  const assistantData = await request('/api/bootstrap');
  assert.ok(assistantData.value.errands.some(item => item.id === created.value.id));
  assert.deepEqual(assistantData.value.audit, []);

  const completed = await request(`/api/errands/${created.value.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  assert.equal(completed.value.status, 'done');
  const verbal = await request('/api/errands', { method: 'POST', body: JSON.stringify({ title: 'Устное поручение директора', date: '2026-08-14', assigneeId: 'aman', status: 'new' }) });
  assert.equal(verbal.response.status, 201);

  cookie = directorCookie;
  const directorData = await request('/api/bootstrap');
  assert.equal(directorData.value.errands.find(item => item.id === created.value.id).status, 'done');
  assert.ok(directorData.value.errands.some(item => item.id === verbal.value.id));
  assert.ok(directorData.value.audit.some(item => item.entityId === created.value.id && item.action === 'update'));
});

test('роли изолированы, а сервер проверяет связанные данные', async () => {
  const directorCookie = cookie;
  const privateEvent = await request('/api/events', { method: 'POST', body: JSON.stringify({ title: 'Только директору', date: '2026-08-15', participants: ['director'] }) });
  assert.equal(privateEvent.response.status, 201);
  const badAssignee = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Ошибка', date: '2026-08-15', assigneeId: 'unknown' }) });
  assert.equal(badAssignee.response.status, 400);
  const badDate = await request('/api/events', { method: 'POST', body: JSON.stringify({ title: 'Ошибка', date: 'не-дата' }) });
  assert.equal(badDate.response.status, 400);

  cookie = '';
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ userId: 'aman', password: '1234' }) });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const assistantData = await request('/api/bootstrap');
  assert.equal(assistantData.value.events.some(item => item.id === privateEvent.value.id), false);
  const forbidden = await request(`/api/events/${privateEvent.value.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Взлом' }) });
  assert.equal(forbidden.response.status, 403);
  cookie = directorCookie;
});

test('комментарий о результате сохраняется после повторной загрузки', async () => {
  const created = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Задача с результатом', date: '2026-08-15', assigneeId: 'aman' }) });
  const changed = await request(`/api/tasks/${created.value.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done', resultComment: 'Документы переданы директору' }) });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.value.resultComment, 'Документы переданы директору');
  const reloaded = await request('/api/bootstrap');
  assert.equal(reloaded.value.tasks.find(item => item.id === created.value.id).resultComment, 'Документы переданы директору');
});

test('матрица продукции: магазин, продукт, статусы, история и задача', async () => {
  const store = await request('/api/stores', { method: 'POST', body: JSON.stringify({ name: 'Тестовый Globus', address: 'ул. Тестовая, 1', district: 'Центр', agent: 'Тест Агент', supervisor: 'Тест Супервайзер' }) });
  const product = await request('/api/products', { method: 'POST', body: JSON.stringify({ name: 'Тестовый продукт', category: 'Напитки', variant: 'Яблоко' }) });
  assert.equal(store.response.status, 201); assert.equal(product.response.status, 201);
  const present = await request('/api/matrix', { method: 'POST', body: JSON.stringify({ storeId: store.value.id, productId: product.value.id, status: 'yes', quantity: 8, comment: 'На полке' }) });
  assert.equal(present.value.status, 'yes'); assert.equal(present.value.quantity, 8);
  const absent = await request('/api/matrix', { method: 'POST', body: JSON.stringify({ storeId: store.value.id, productId: product.value.id, status: 'no', quantity: 0, comment: 'Закончился' }) });
  assert.equal(absent.value.status, 'no');
  const data = await request('/api/bootstrap');
  assert.equal(data.value.matrix[`${store.value.id}:${product.value.id}`].comment, 'Закончился');
  assert.equal(data.value.matrixHistory.filter(item => item.storeId === store.value.id && item.productId === product.value.id).length, 2);
  const task = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: `Обеспечить наличие: ${product.value.name}`, description: `Магазин: ${store.value.name}`, date: '2026-08-12', assigneeId: 'aman', category: 'Торговые точки' }) });
  assert.equal(task.response.status, 201);
});

test('ассистент может редактировать магазины и матрицу, но не продукты', async () => {
  const directorCookie = cookie;
  cookie = '';
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ userId: 'aman', password: '1234' }) });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  const store = await request('/api/stores', { method: 'POST', body: JSON.stringify({ name: 'Точка Амана', address: 'ул. Помощника, 2' }) });
  assert.equal(store.response.status, 201);
  const changed = await request(`/api/stores/${store.value.id}`, { method: 'PATCH', body: JSON.stringify({ note: 'Проверено ассистентом' }) });
  assert.equal(changed.value.note, 'Проверено ассистентом');
  const forbidden = await request('/api/products', { method: 'POST', body: JSON.stringify({ name: 'Недоступный продукт' }) });
  assert.equal(forbidden.response.status, 403);
  cookie = directorCookie;
});

test('выход завершает сессию', async () => {
  const logout = await request('/api/auth/logout', { method: 'POST', body: '{}' });
  assert.equal(logout.response.status, 200);
  const closed = await request('/api/bootstrap');
  assert.equal(closed.response.status, 401);
});
