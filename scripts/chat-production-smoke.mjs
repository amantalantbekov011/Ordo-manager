import assert from 'node:assert/strict';
const base=(process.env.BASE_URL||'').replace(/\/$/,''); assert.match(base,/^https:\/\//);
async function request(path,cookie='',method='GET',body){const response=await fetch(base+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined});const value=await response.json().catch(()=>({}));return{response,value,cookie:response.headers.get('set-cookie')?.split(';')[0]||cookie};}
async function login(userId,password){const result=await request('/api/auth/login','','POST',{userId,password});assert.equal(result.response.status,200);return result.cookie;}
const director=await login('director',process.env.DIRECTOR_PASSWORD||'1234'),assistant=await login('aman',process.env.ASSISTANT_PASSWORD||'1234');
const conversation=await request('/api/chat/conversations',director,'POST',{memberId:'aman'});assert.equal(conversation.response.status,201);const id=conversation.value.id,mark=`PUBLIC-CHAT-${Date.now()}`;
for(const text of [`${mark} Сообщение 1 👋`,`${mark} Сообщение 2`,`${mark} ${'длинный текст '.repeat(40)}`])assert.equal((await request(`/api/chat/conversations/${id}/messages`,director,'POST',{text})).response.status,201);
let received;for(let attempt=0;attempt<6;attempt++){received=await request(`/api/chat/conversations/${id}/messages?limit=30`,assistant);if(received.value.messages?.filter(item=>item.text.startsWith(mark)).length===3)break;await new Promise(resolve=>setTimeout(resolve,1000));}
assert.equal(received.value.messages.filter(item=>item.text.startsWith(mark)).length,3);assert.ok((await request('/api/chat/conversations',assistant)).value.find(item=>item.id===id).unread>=3);
assert.equal((await request(`/api/chat/conversations/${id}/read`,assistant,'POST',{})).response.status,200);
const reply=await request(`/api/chat/conversations/${id}/messages`,assistant,'POST',{text:`${mark} Ответ получен`});assert.equal(reply.response.status,201);
const pdf=Buffer.from('%PDF-1.4\n1 0 obj\n%%EOF').toString('base64');const fileMessage=await request(`/api/chat/conversations/${id}/messages`,director,'POST',{text:`${mark} Файл`,attachment:{name:'проверка.pdf',mime:'application/pdf',data:pdf}});assert.equal(fileMessage.response.status,201);const fileId=fileMessage.value.attachments[0].id;
assert.equal((await fetch(`${base}/api/attachments/${fileId}`,{headers:{cookie:assistant}})).status,200);
const directorAgain=await login('director',process.env.DIRECTOR_PASSWORD||'1234');const persisted=await request(`/api/chat/conversations/${id}/messages?limit=30`,directorAgain);assert.ok(persisted.value.messages.some(item=>item.id===reply.value.id));assert.ok(persisted.value.messages.find(item=>item.text.startsWith(mark))?.readAt);
console.log(JSON.stringify({ok:true,url:base,conversation:id,realtimePolling:true,delivery:true,read:true,reply:true,attachment:true,reloginPersistence:true}));
