import assert from 'node:assert/strict';

const base = (process.env.BASE_URL || '').replace(/\/$/, '');
assert.match(base, /^https:\/\//, 'BASE_URL must be an HTTPS URL');

async function call(path, { method = 'GET', body, cookie = '' } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual'
  });
  const value = await response.json().catch(() => ({}));
  return { response, value, cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
}

async function login(userId, password) {
  const result = await call('/api/auth/login', { method: 'POST', body: { userId, password } });
  assert.equal(result.response.status, 200, `login failed for ${userId}: ${JSON.stringify(result.value)}`);
  return result;
}

const health = await call('/health');
assert.equal(health.response.status, 200);
assert.equal(health.value.status, 'ok');
assert.equal(health.value.storage.connected, true);

const page = await fetch(`${base}/`);
assert.equal(page.status, 200);
assert.match(page.headers.get('content-type') || '', /text\/html/);
assert.match(await page.text(), /ORDO Manager/);

const anonymous = await call('/api/bootstrap');
assert.equal(anonymous.response.status, 401);

const director = await login('director', process.env.DIRECTOR_PASSWORD || '1234');
assert.equal(director.value.user.role, 'director');
assert.equal(director.value.user.name, 'Эрлан Атанбекович');
const directorData = await call('/api/bootstrap', { cookie: director.cookie });
assert.equal(directorData.response.status, 200);
assert.deepEqual([...new Set(directorData.value.users.map(user => user.role))].sort(), ['assistant', 'director']);
assert.ok(directorData.value.locations.some(item => item.type === 'head_office'));
assert.ok(directorData.value.locations.some(item => item.type === 'warehouse'));

for (const [collection, path] of [['products', '/api/products'], ['locations', '/api/locations'], ['stores', '/api/stores'], ['errands', '/api/errands'], ['events', '/api/events'], ['tasks', '/api/tasks']]) {
  for (const item of directorData.value[collection].filter(entry => /^(PROD-(SMOKE|MEETING|ERRAND|STORE|LOCATION|PRODUCT)-)/.test(entry.title || entry.name || ''))) {
    const removed = await call(`${path}/${item.id}`, { method: 'DELETE', cookie: director.cookie });
    assert.equal(removed.response.status, 200, `stale cleanup ${path}/${item.id}`);
  }
}

const stamp = Date.now();
const created = [];
async function create(path, body) {
  const result = await call(path, { method: 'POST', body, cookie: director.cookie });
  assert.equal(result.response.status, 201, `${path}: ${JSON.stringify(result.value)}`);
  created.push([path, result.value.id]);
  assert.ok(result.value.createdAt);
  assert.ok(result.value.updatedAt);
  return result.value;
}

const task = await create('/api/tasks', { title: `PROD-SMOKE-${stamp}`, date: '2026-09-12', assigneeId: 'aman', status: 'new' });
const event = await create('/api/events', { title: `PROD-MEETING-${stamp}`, date: '2026-09-12', type: 'meeting', participants: ['director', 'aman'] });
const errand = await create('/api/errands', { title: `PROD-ERRAND-${stamp}`, date: '2026-09-12', assigneeId: 'aman', status: 'new' });
const store = await create('/api/stores', { name: `PROD-STORE-${stamp}`, address: 'Временная проверка' });
const location = await create('/api/locations', { name: `PROD-LOCATION-${stamp}`, type: 'warehouse', status: 'active' });
const product = await create('/api/products', { name: `PROD-PRODUCT-${stamp}`, category: 'Проверка' });

const updated = await call(`/api/tasks/${task.id}`, { method: 'PATCH', body: { status: 'work' }, cookie: director.cookie });
assert.equal(updated.response.status, 200);
assert.equal(updated.value.status, 'work');
assert.ok(updated.value.updatedAt >= updated.value.createdAt);

const matrix = await call('/api/matrix', { method: 'POST', body: { storeId: store.id, productId: product.id, status: 'yes', quantity: 1 }, cookie: director.cookie });
assert.equal(matrix.response.status, 200);

const assistant = await login('aman', process.env.ASSISTANT_PASSWORD || '1234');
assert.equal(assistant.value.user.role, 'assistant');
assert.equal(assistant.value.user.name, 'Аман Талантбекович');
const assistantData = await call('/api/bootstrap', { cookie: assistant.cookie });
assert.ok(assistantData.value.tasks.some(item => item.id === task.id));
assert.ok(assistantData.value.events.some(item => item.id === event.id));
assert.ok(assistantData.value.errands.some(item => item.id === errand.id));
assert.deepEqual(assistantData.value.audit, []);
const forbidden = await call('/api/products', { method: 'POST', body: { name: 'FORBIDDEN' }, cookie: assistant.cookie });
assert.equal(forbidden.response.status, 403);

const completed = await call(`/api/errands/${errand.id}`, { method: 'PATCH', body: { status: 'done' }, cookie: assistant.cookie });
assert.equal(completed.response.status, 200);
const synced = await call('/api/bootstrap', { cookie: director.cookie });
assert.equal(synced.value.errands.find(item => item.id === errand.id)?.status, 'done');

const logout = await call('/api/auth/logout', { method: 'POST', body: {}, cookie: assistant.cookie });
assert.equal(logout.response.status, 200);
assert.equal((await call('/api/bootstrap', { cookie: assistant.cookie })).response.status, 401);

for (const [path, id] of created.reverse()) {
  const removed = await call(`${path}/${id}`, { method: 'DELETE', cookie: director.cookie });
  assert.equal(removed.response.status, 200, `cleanup ${path}/${id}`);
}

console.log(JSON.stringify({ ok: true, url: base, storage: health.value.storage.driver, roles: ['director', 'assistant'], sync: true, cleanup: true }));
