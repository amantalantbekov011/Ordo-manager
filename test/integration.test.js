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
  assert.equal(value.storage.driver, 'json');
  assert.equal(value.storage.connected, true);
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
  assert.match(currentHtml, /<button data-page="stores">/);
  assert.match(currentHtml, /app\.js\?v=[^"']+/);
  assert.match(await (await fetch(`${base}/app.js`)).text(), /stores: renderStores/);
  assert.match(await (await fetch(`${base}/app.js`)).text(), /pages\.has\(requestedPage\)/);
  assert.match(await (await fetch(`${base}/app.js`)).text(), /chatPollBusy/);
  assert.match(await (await fetch(`${base}/app.js`)).text(), /reportChatError/);
  assert.match(await (await fetch(`${base}/app.js`)).text(), /retryChat/);
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
  assert.deepEqual(bootstrap.value.users.map(user => user.role).sort(), ['assistant', 'director']);
  assert.equal(bootstrap.value.employees[0].name, 'Аман Талантбекович');
  assert.deepEqual(bootstrap.value.locations.map(item => item.name), ['Головной офис', 'Склад №1', 'Склад №2']);
  assert.ok(bootstrap.value.tasks.some(item => item.status === 'done'));
  assert.ok(bootstrap.value.tasks.some(item => item.status !== 'done' && item.date < new Date().toISOString().slice(0, 10)));
});

test('создание, изменение и удаление задачи', async () => {
  const created = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Тестовая задача', date: '2026-08-12', assigneeId: 'aman', priority: 'high' }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.value.title, 'Тестовая задача');
  assert.ok(created.value.createdAt);
  assert.ok(created.value.updatedAt);
  const changed = await request(`/api/tasks/${created.value.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  assert.equal(changed.value.status, 'done');
  assert.ok(changed.value.updatedAt >= changed.value.createdAt);
  const removed = await request(`/api/tasks/${created.value.id}`, { method: 'DELETE' });
  assert.equal(removed.value.ok, true);
});

test('создание встречи, поручения и сотрудника', async () => {
  const meeting = await request('/api/events', { method: 'POST', body: JSON.stringify({ title: 'Тестовая встреча', date: '2026-08-13', type: 'meeting', participants: ['director', 'aman'] }) });
  const errand = await request('/api/errands', { method: 'POST', body: JSON.stringify({ title: 'Тестовое поручение', date: '2026-08-13', place: 'Офис' }) });
  const employee = await request('/api/employees', { method: 'POST', body: JSON.stringify({ name: 'Тестовый Сотрудник', position: 'Специалист' }) });
  assert.equal(meeting.response.status, 201);
  assert.equal(errand.response.status, 201);
  assert.equal(employee.response.status, 201);
  assert.deepEqual(meeting.value.participants.sort(), ['aman', 'director']);
});

test('регистрация компании и жёсткая изоляция арендаторов', async () => {
  const registration = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ companyName: 'Изолированная компания', name: 'Тестовый Руководитель', phone: '+996 700 000 000', email: 'tenant@example.com', password: 'Secure123!', passwordConfirm: 'Secure123!' }) });
  assert.equal(registration.status, 201);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'tenant@example.com', password: 'Secure123!' }) });
  assert.equal(login.status, 200); const tenantCookie = login.headers.get('set-cookie').split(';')[0];
  const tenantData = await (await fetch(`${base}/api/bootstrap`, { headers: { Cookie: tenantCookie } })).json();
  assert.equal(tenantData.company.name, 'Изолированная компания');
  assert.equal(tenantData.users.length, 1); assert.equal(tenantData.tasks.length, 0); assert.equal(tenantData.stores.length, 0); assert.equal(tenantData.locations.length, 1);
  const emptyChat = await fetch(`${base}/api/chat/conversations`, { headers: { Cookie: tenantCookie } });
  assert.equal(emptyChat.status, 200); assert.deepEqual(await emptyChat.json(), []);
  const foreignTask = await fetch(`${base}/api/tasks/task_1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: tenantCookie }, body: JSON.stringify({ status: 'done' }) });
  const foreignStore = await fetch(`${base}/api/stores/store_1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: tenantCookie }, body: JSON.stringify({ note: 'Попытка доступа' }) });
  assert.equal(foreignTask.status, 404); assert.equal(foreignStore.status, 404);
  const created = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: tenantCookie }, body: JSON.stringify({ title: 'Своя задача', date: '2026-08-20', assigneeId: tenantData.user.id }) });
  assert.equal(created.status, 201);
  const directorData = await request('/api/bootstrap');
  assert.equal(directorData.value.tasks.some(item => item.title === 'Своя задача'), false);
  assert.equal(directorData.value.users.some(item => item.email === 'tenant@example.com'), false);
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
  assert.ok(assistantData.value.notifications.some(item => item.entityId === created.value.id && item.type === 'assignment'));
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
  assert.ok(directorData.value.notifications.some(item => item.entityId === created.value.id && item.type === 'status'));
});

test('роли изолированы, а сервер проверяет связанные данные', async () => {
  const directorCookie = cookie;
  const directorPresence = await request('/api/presence', { method: 'POST', body: JSON.stringify({ value: 'На складе №1' }) });
  assert.equal(directorPresence.response.status, 403);
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
  const assistantPresence = await request('/api/presence', { method: 'POST', body: JSON.stringify({ value: 'На складе №1', note: 'Проверка склада' }) });
  assert.equal(assistantPresence.response.status, 200);
  assert.equal(assistantPresence.value.userId, 'aman');
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
  const comment = await request(`/api/tasks/${created.value.id}/comments`, { method: 'POST', body: JSON.stringify({ text: 'Комментарий сохранён отдельно' }) });
  assert.equal(comment.response.status, 201);
  const withComment = await request('/api/bootstrap');
  assert.equal(withComment.value.tasks.find(item => item.id === created.value.id).comments[0].text, 'Комментарий сохранён отдельно');
});

test('вложения защищены авторизацией, компанией и проверкой формата', async () => {
  const created = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Задача с файлом', date: '2026-08-16', assigneeId: 'aman' }) });
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n%%EOF').toString('base64');
  const uploaded = await request(`/api/tasks/${created.value.id}/attachments`, { method: 'POST', body: JSON.stringify({ name: '../отчёт.pdf', mime: 'application/pdf', data: pdf }) });
  assert.equal(uploaded.response.status, 201); assert.equal(uploaded.value.name, 'отчёт.pdf'); assert.equal('storageName' in uploaded.value, false);
  const reloaded = await request('/api/bootstrap'), attachment = reloaded.value.tasks.find(item => item.id === created.value.id).attachments[0];
  assert.equal(attachment.name, 'отчёт.pdf'); assert.equal('storageName' in attachment, false);
  const downloaded = await fetch(`${base}/api/attachments/${attachment.id}`, { headers: { Cookie: cookie } });
  assert.equal(downloaded.status, 200); assert.match(downloaded.headers.get('content-type'), /application\/pdf/);
  const fake = await request(`/api/tasks/${created.value.id}/attachments`, { method: 'POST', body: JSON.stringify({ name: 'fake.png', mime: 'image/png', data: Buffer.from('not an image').toString('base64') }) });
  assert.equal(fake.response.status, 400);
  const anonymous = await fetch(`${base}/api/attachments/${attachment.id}`); assert.equal(anonymous.status, 401);
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

test('объекты компании связаны с задачами и встречами', async () => {
  const bootstrap = await request('/api/bootstrap'); const warehouse = bootstrap.value.locations.find(item => item.name === 'Склад №1');
  const edited = await request(`/api/locations/${warehouse.id}`, { method:'PATCH', body:JSON.stringify({ address:'Тестовый адрес склада', responsible:'Аман', phone:'+996 555 000 001' }) });
  assert.equal(edited.value.address, 'Тестовый адрес склада');
  const task = await request('/api/tasks', { method:'POST', body:JSON.stringify({ title:'Задача склада', date:'2026-08-14', assigneeId:'aman', locationId:warehouse.id }) });
  const event = await request('/api/events', { method:'POST', body:JSON.stringify({ title:'Встреча склада', date:'2026-08-14', participants:['director','aman'], locationId:warehouse.id }) });
  assert.equal(task.value.locationId, warehouse.id); assert.equal(event.value.locationId, warehouse.id);
  const persisted = await request('/api/bootstrap');
  assert.equal(persisted.value.tasks.find(item=>item.id===task.value.id).locationId, warehouse.id);
  assert.equal(persisted.value.events.find(item=>item.id===event.value.id).locationId, warehouse.id);
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

test('чат синхронизирует сообщения, непрочитанные, прочтение и защищает membership', async () => {
  const signIn = async userId => {
    const response = await fetch(`${base}/api/auth/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId,password:'1234'}) });
    assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0];
  };
  const directorCookie = await signIn('director'), assistantCookie = await signIn('aman');
  const chatRequest = async (path, cookieValue, method='GET', body) => {
    const response = await fetch(`${base}${path}`, { method, headers:{'Content-Type':'application/json',Cookie:cookieValue}, body:body?JSON.stringify(body):undefined });
    return { response, value:await response.json() };
  };
  const conversation = await chatRequest('/api/chat/conversations', directorCookie, 'POST', {memberId:'aman'});
  assert.equal(conversation.response.status, 201);
  const id = conversation.value.id;
  const sent = await chatRequest(`/api/chat/conversations/${id}/messages`, directorCookie, 'POST', {text:`Привет 👋 ${'длинный текст '.repeat(80)}`});
  assert.equal(sent.response.status, 201); assert.equal(sent.value.readAt, undefined);
  const dedupeKey = `test-${Date.now()}`, once = await chatRequest(`/api/chat/conversations/${id}/messages`, directorCookie, 'POST', {text:'Один раз',clientId:dedupeKey}), twice = await chatRequest(`/api/chat/conversations/${id}/messages`, directorCookie, 'POST', {text:'Один раз',clientId:dedupeKey});
  assert.equal(once.value.id, twice.value.id);
  const assistantList = await chatRequest('/api/chat/conversations', assistantCookie);
  assert.ok(assistantList.value.find(item=>item.id===id).unread >= 1);
  const assistantMessages = await chatRequest(`/api/chat/conversations/${id}/messages?limit=30`, assistantCookie);
  assert.match(assistantMessages.value.messages.find(item=>item.id===sent.value.id).text, /👋/);
  await chatRequest(`/api/chat/conversations/${id}/read`, assistantCookie, 'POST', {});
  const directorMessages = await chatRequest(`/api/chat/conversations/${id}/messages`, directorCookie);
  assert.ok(directorMessages.value.messages.find(item=>item.id===sent.value.id).readAt);
  const reply = await chatRequest(`/api/chat/conversations/${id}/messages`, assistantCookie, 'POST', {text:'Получено, отвечаю без перезагрузки'});
  assert.equal(reply.response.status, 201);
  const task = await fetch(`${base}/api/tasks`, {method:'POST',headers:{'Content-Type':'application/json',Cookie:directorCookie},body:JSON.stringify({title:'Задача из проверки чата',date:'2026-09-12',assigneeId:'aman'})});
  assert.equal(task.status, 201);
  const withSystem = await chatRequest(`/api/chat/conversations/${id}/messages`, assistantCookie);
  assert.ok(withSystem.value.messages.some(item=>item.type==='task'&&item.text.includes('Задача из проверки чата')));
  const hidden = await chatRequest(`/api/chat/conversations/not-a-member/messages`, assistantCookie);
  assert.equal(hidden.response.status, 404);
});

test('выход завершает сессию', async () => {
  const logout = await request('/api/auth/logout', { method: 'POST', body: '{}' });
  assert.equal(logout.response.status, 200);
  const closed = await request('/api/bootstrap');
  assert.equal(closed.response.status, 401);
});

test('данные сохраняются после полного перезапуска сервера', async () => {
  const restartPort = 32188, restartBase = `http://127.0.0.1:${restartPort}`, restartFile = path.join(temp, 'restart-db.json');
  const start = async () => {
    const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(restartPort), HOST: '127.0.0.1', DATA_FILE: restartFile }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { const timer=setTimeout(()=>reject(new Error('Сервер перезапуска не запустился')),5000); child.stdout.on('data',chunk=>{if(chunk.toString().includes('ORDO Manager')){clearTimeout(timer);resolve();}}); });
    return child;
  };
  let child = await start();
  let response = await fetch(`${restartBase}/api/auth/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId:'director',password:'1234'}) });
  const restartCookie=response.headers.get('set-cookie').split(';')[0];
  response=await fetch(`${restartBase}/api/stores`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:restartCookie},body:JSON.stringify({name:'Переживает перезапуск',address:'Постоянный адрес'})});
  const savedStore=await response.json(); assert.equal(response.status,201);
  child.kill(); await new Promise(resolve=>child.once('exit',resolve)); child=await start();
  response=await fetch(`${restartBase}/api/bootstrap`,{headers:{Cookie:restartCookie}}); assert.equal(response.status,200);
  response=await fetch(`${restartBase}/api/auth/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId:'director',password:'1234'}) });
  const secondCookie=response.headers.get('set-cookie').split(';')[0];
  response=await fetch(`${restartBase}/api/bootstrap`,{headers:{Cookie:secondCookie}}); const persisted=await response.json();
  assert.ok(persisted.stores.some(store=>store.id===savedStore.id)); child.kill();
});
