import {parseTrack, resolveTrack, filename, audioSize} from './core.js';
import {senderRole,allowsCommand,validKey,MAX_AUDIO_BYTES} from './security.js';

let resolving = null;
let preview=null;
const sizeCache=new Map();
const pendingSizes=new Map();
async function trackSize(value){
  const id=parseTrack(value);
  if(pendingSizes.has(id))return pendingSizes.get(id);
  const promise=measureTrackSize(id).finally(()=>pendingSizes.delete(id));
  pendingSizes.set(id,promise);return promise;
}
async function measureTrackSize(value){
  await ready;
  const id=parseTrack(value),cached=sizeCache.get(id);
  if(cached&&Date.now()-cached.time<10*60*1000)return {ok:true,bytes:cached.bytes};
  if(resolving||preview)return {ok:false,retryable:true,error:'Узнаю размер…'};
  const controller=new AbortController();preview=controller;
  const timeout=setTimeout(()=>controller.abort(),12000);
  try{
    const {lastRequest=0}=await chrome.storage.session.get('lastRequest');
    const delay=Math.max(0,1600-(Date.now()-lastRequest));
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    controller.signal.throwIfAborted();
    await chrome.storage.session.set({lastRequest:Date.now()});
    let bytes;
    for(let attempt=0;attempt<2;attempt++){
      let audio;
      try{audio=attempt?await refreshAudio(id,controller.signal):await resolveTrack(id,{signal:controller.signal});}
      catch(error){if(error.code!=='TRACK_UNAVAILABLE')throw error;audio=await resolveWithSession(id,controller.signal,()=>{});}
      try{bytes=await audioSize(audio.url,{signal:controller.signal});break;}
      catch(error){if(attempt||error.code!=='STALE_AUDIO_URL')throw error;await new Promise(resolve=>setTimeout(resolve,1600));controller.signal.throwIfAborted();await chrome.storage.session.set({lastRequest:Date.now()});}
    }
    if(bytes>MAX_AUDIO_BYTES)throw Error('Файл больше лимита загрузки');
    sizeCache.set(id,{bytes,time:Date.now()});
    if(sizeCache.size>200)sizeCache.delete(sizeCache.keys().next().value);
    return {ok:true,bytes};
  }catch{return {ok:false,retryable:true,error:'Сервер не сообщил размер'};}
  finally{clearTimeout(timeout);if(preview===controller)preview=null;}
}
const names = new Map();
let creatingBuffer;
async function ensureBuffer(){
  const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('offscreen.html')]});
  if(contexts.length)return;
  if(!creatingBuffer)creatingBuffer=chrome.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS'],justification:'Получить и проверить полный MP3 до сохранения, чтобы не скачивать страницы ошибок вместо музыки.'}).finally(()=>creatingBuffer=null);
  await creatingBuffer;
}
async function releaseBuffer(key){
  await chrome.runtime.sendMessage({target:'audio-buffer',type:'release',key}).catch(()=>{});
}
const ready = (async () => {
  await chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  const {jobs = []} = await chrome.storage.session.get('jobs');
  for (const job of jobs) {
    if (job.state === 'resolving') { job.state='error';job.message='Браузер перезапустил обработчик. Повтори скачивание.'; }
    if (job.downloadId !== undefined && job.state === 'downloading') {
      const [download] = await chrome.downloads.search({id:job.downloadId});
      if(download?.state==='complete') {job.state='complete';job.message='Готово: '+download.filename;}
      else if(!download || download.state==='interrupted') {job.state='error';job.message='Загрузка прервана. Повтори попытку.';}
    }
  }
  await chrome.storage.session.set({jobs});
})();
let writeQueue = Promise.resolve();
function changeJobs(transform) {
  const operation = writeQueue.then(async () => {
    const {jobs=[]}=await chrome.storage.session.get('jobs');
    await chrome.storage.session.set({jobs:transform(jobs).slice(0,30)});
  });
  writeQueue=operation.catch(()=>{});
  return operation;
}
async function update(job, patch) {
  Object.assign(job,patch);
  await changeJobs(jobs=>jobs.map(item=>item.key===job.key ? {...item,...patch} : item));
}
async function log(job, message) {
  const logs = [...(job.logs||[]), new Date().toLocaleTimeString()+' '+message].slice(-20);
  await update(job,{logs,message});
}

// Same-origin request inside a VK tab: use the existing session without extracting cookies.
async function fetchInVk(track,forceReload=false) {
  const base=track.split('_').slice(0,2).join('_');
  const viewerId=Number(window.vk?.id)||0;
  if(!viewerId)return {error:'В открытой вкладке ВК не обнаружен вход в аккаунт. Войди в ВК и повтори скачивание.'};
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),18000);
  async function request(params){
    const response=await fetch('/music',{method:'POST',credentials:'include',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},body:new URLSearchParams({al:'1',...params}).toString()});
    if(!response.ok)throw Error('HTTP '+response.status);
    const charset=/charset\s*=\s*["']?([^;\s"']+)/i.exec(response.headers.get('Content-Type')||'')?.[1]||'utf-8';
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2*1024*1024)throw Error('Слишком большой ответ ВК.');chunks.push(part.value);}}
    finally{await reader.cancel().catch(()=>{});}
    return JSON.parse(new TextDecoder(charset).decode(await new Blob(chunks).arrayBuffer()).replace(/^\s*<!--/,''));
  }
  function find(data){
    const queue=[data];let scanned=0;
    while(queue.length&&++scanned<15000){const item=queue.pop();if(!item||typeof item!=='object')continue;if(Array.isArray(item)&&`${item[1]}_${item[0]}`===base&&typeof item[2]==='string')return item;if(`${item.owner_id}_${item.id}`===base&&typeof item.url==='string')return item;for(const child of Object.values(item))if(child&&typeof child==='object')queue.push(child);}
    return null;
  }
  try {
    const variants=track===base?[base]:[track,base];
    let data=null;
    for(const value of variants){
      data=await request({act:'reload_audios',audio_ids:value});
      let item=find(data);
      if(item){
        let reloaded=false;
        if(forceReload){
          const parts=Array.isArray(item)&&typeof item[13]==='string'?item[13].split('/'):[];
          const action=Array.isArray(item)?parts[2]:item.actionHash||item.action_hash;
          const urlHash=Array.isArray(item)?parts[5]:item.urlHash||item.url_hash;
          if(typeof action!=='string'||typeof urlHash!=='string'||!/^[-a-zA-Z0-9]{1,128}$/.test(action)||!/^[-a-zA-Z0-9]{1,128}$/.test(urlHash))return {error:'ВК не предоставил параметры обновления аудиоадреса этой записи.'};
          const updated=find(await request({act:'reload_audio',ids:base+'_'+action+'_'+urlHash}));
          if(!updated)return {error:'ВК отклонил обновление аудиоадреса. Обнови вкладку ВК и повтори.'};
          item=updated;reloaded=true;
        }
        data=Array.isArray(item)?{payload:[0,[[item.slice(0,6)]]]}:{owner_id:item.owner_id,id:item.id,url:item.url,title:item.title,artist:item.artist||item.performer,duration:item.duration};
        return {data,viewerId,reloaded};
      }
    }
    return {data:{},viewerId};
  }catch{return {error:'Не удалось получить данные через вкладку ВК. Обнови её и повтори.'};}
  finally{clearTimeout(timeout);}
}
async function resolveWithSession(id,signal,onLog,forceReload=false) {
  const tabs=await chrome.tabs.query({url:['https://vk.ru/*','https://vk.com/*','https://www.vk.ru/*','https://www.vk.com/*']});
  if(!tabs.length)throw Error('Для этого трека нужен текущий вход в ВК. Открой vk.ru в этом браузере, войди и повтори скачивание.');
  let lastError;
  for(const tab of tabs.slice(0,4)){
    signal.throwIfAborted();
    try{
      const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:fetchInVk,args:[id,forceReload]});
      signal.throwIfAborted();
      if(result?.result?.error){lastError=Error(result.result.error);continue;}
      const {data,viewerId}=result.result;
      if(result.result.reloaded)onLog('ВК обновил аудиоадрес вызовом reload_audio.');
      const fetcher=async()=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json; charset=utf-8'}});
      return await resolveTrack(id,{fetcher,userId:viewerId,credentials:'include',signal,onLog});
    }catch(error){if(signal.aborted)throw error;lastError=error;}
  }
  throw lastError||Error('ВК не дал доступ к этому треку через открытые вкладки.');
}

async function refreshAudio(id,signal,onLog=()=>{}){
  // A fresh anonymous URL can still be unusable. Prefer the user's existing VK session.
  try{return await resolveWithSession(id,signal,onLog,true);}
  catch(error){if(signal.aborted)throw error;try{return await resolveTrack(id,{signal});}catch{throw error;}}
}

// This function reads track identity only. It never starts playback or reads credentials.
function identifyRow(token) {
  const row=document.querySelector('[data-vkms-row="'+token+'"]');
  if(!row) throw Error('Строка трека исчезла. Нажми кнопку ещё раз.');
  const valid = a => {
    const owner=a?.owner_id??a?.ownerId, id=a?.id;
    if(!/^-?\d+$/.test(String(owner))||!/^\d+$/.test(String(id)))return null;
    const key=typeof a.access_key==='string'&&/^[a-zA-Z0-9-]{1,128}$/.test(a.access_key)?'_'+a.access_key:'';
    return String(owner)+'_'+String(id)+key;
  };
  let fallbackId=null;
  for (const attr of ['data-full-id','data-audio-id']) {
    const id=row.getAttribute(attr);if(/^-?\d+_\d+_[a-zA-Z0-9-]{1,128}$/.test(id||'')) return id;
    if(/^-?\d+_\d+$/.test(id||''))fallbackId=id;
  }
  try {
    const a=JSON.parse(row.getAttribute('data-audio'));
    const id=Array.isArray(a)?valid({owner_id:a[1],id:a[0],access_key:typeof a[24]==='string'?a[24]:undefined}):valid(a);
    if(id&&id.split('_').length>2)return id;
    if(id)fallbackId=id;
  } catch {}
  const hrefs=[...(row.matches('a[href]')?[row]:[]),...row.querySelectorAll('a[href]')];
  for(const a of hrefs){const m=/^\/audio(-?\d+_\d+(?:_[a-zA-Z0-9-]{1,128})?)\/?$/.exec(new URL(a.href,location.href).pathname);if(m&&m[1].split('_').length>2)return m[1];if(m)fallbackId=m[1];}
  const seen=new Set();
  function audioIn(value,depth) {
    if(!value || typeof value!=='object' || depth===0 || seen.has(value))return null;
    seen.add(value);
    if(Array.isArray(value)&&typeof value[2]==='string'&&typeof value[3]==='string'&&typeof value[5]==='number'){
      const tupleId=valid({id:value[0],owner_id:value[1],access_key:value[24]});if(tupleId)return tupleId;
    }
    // Require audio-like fields, rather than confusing a playlist or artist ID with audio.
    const id=valid(value);
    if(id && ('duration' in value || 'title' in value) && ('artist' in value || 'performer' in value || 'url' in value))return id;
    for(const key of ['track','audio','entity','apiAudio','data','originalAttachment','episode','item','attachment','song','audioItem','audioData','audioRecord']) {
      const hit=audioIn(value[key],depth-1);if(hit)return hit;
    }
    return null;
  }
  for(const node of [row,...[...row.querySelectorAll('*')].slice(0,35)]) {
    const key=Object.keys(node).find(k=>k.startsWith('__reactFiber$')||k.startsWith('__reactInternalInstance$'));
    let fiber=key?node[key]:null;
    for(let depth=0;fiber && depth<12;depth++,fiber=fiber.return) {
      const id=audioIn(fiber.memoizedProps,8);if(id)return id;
      // Do not walk into unrelated rows or the full catalog.
      if(fiber.stateNode instanceof Element && fiber.stateNode!==row && !row.contains(fiber.stateNode))break;
    }
  }
  if(fallbackId)return fallbackId;
  throw Error('Не удалось прочитать ID этой строки ВК. Используй короткую ссылку в окне расширения.');
}

function discoverSearchRowsWithIdentity() {
  function identifyRow(token) {
  const row=document.querySelector('[data-vkms-row="'+token+'"]');
  if(!row) throw Error('Строка трека исчезла. Нажми кнопку ещё раз.');
  const valid = a => {
    const owner=a?.owner_id??a?.ownerId, id=a?.id;
    if(!/^-?\d+$/.test(String(owner))||!/^\d+$/.test(String(id)))return null;
    const key=typeof a.access_key==='string'&&/^[a-zA-Z0-9-]{1,128}$/.test(a.access_key)?'_'+a.access_key:'';
    return String(owner)+'_'+String(id)+key;
  };
  let fallbackId=null;
  for (const attr of ['data-full-id','data-audio-id']) {
    const id=row.getAttribute(attr);if(/^-?\d+_\d+_[a-zA-Z0-9-]{1,128}$/.test(id||'')) return id;
    if(/^-?\d+_\d+$/.test(id||''))fallbackId=id;
  }
  try {
    const a=JSON.parse(row.getAttribute('data-audio'));
    const id=Array.isArray(a)?valid({owner_id:a[1],id:a[0],access_key:typeof a[24]==='string'?a[24]:undefined}):valid(a);
    if(id&&id.split('_').length>2)return id;
    if(id)fallbackId=id;
  } catch {}
  const hrefs=[...(row.matches('a[href]')?[row]:[]),...row.querySelectorAll('a[href]')];
  for(const a of hrefs){const m=/^\/audio(-?\d+_\d+(?:_[a-zA-Z0-9-]{1,128})?)\/?$/.exec(new URL(a.href,location.href).pathname);if(m&&m[1].split('_').length>2)return m[1];if(m)fallbackId=m[1];}
  const seen=new Set();
  function audioIn(value,depth) {
    if(!value || typeof value!=='object' || depth===0 || seen.has(value))return null;
    seen.add(value);
    if(Array.isArray(value)&&typeof value[2]==='string'&&typeof value[3]==='string'&&typeof value[5]==='number'){
      const tupleId=valid({id:value[0],owner_id:value[1],access_key:value[24]});if(tupleId)return tupleId;
    }
    // Require audio-like fields, rather than confusing a playlist or artist ID with audio.
    const id=valid(value);
    if(id && ('duration' in value || 'title' in value) && ('artist' in value || 'performer' in value || 'url' in value))return id;
    for(const key of ['track','audio','entity','apiAudio','data','originalAttachment','episode','item','attachment','song','audioItem','audioData','audioRecord']) {
      const hit=audioIn(value[key],depth-1);if(hit)return hit;
    }
    return null;
  }
  for(const node of [row,...[...row.querySelectorAll('*')].slice(0,35)]) {
    const key=Object.keys(node).find(k=>k.startsWith('__reactFiber$')||k.startsWith('__reactInternalInstance$'));
    let fiber=key?node[key]:null;
    for(let depth=0;fiber && depth<12;depth++,fiber=fiber.return) {
      const id=audioIn(fiber.memoizedProps,8);if(id)return id;
      // Do not walk into unrelated rows or the full catalog.
      if(fiber.stateNode instanceof Element && fiber.stateNode!==row && !row.contains(fiber.stateNode))break;
    }
  }
  if(fallbackId)return fallbackId;
  throw Error('Не удалось прочитать ID этой строки ВК. Используй короткую ссылку в окне расширения.');
}


  if(!/^\/search(?:\/audio)?\/?$/.test(location.pathname))return [];
  const result=[],seen=new Set();
  // Duration labels identify compact audio cells even when VK changes CSS module names.
  for(const label of [...document.querySelectorAll('span,div,time')].slice(0,18000)){
    if(label.children.length||!/^\d{1,3}:\d{2}$/.test(label.textContent.trim())||label.closest('.vkms-download,.vkms-toast'))continue;
    for(let row=label.parentElement,depth=0;row&&row!==document.body&&depth<5;row=row.parentElement,depth++){
      const rect=row.getBoundingClientRect();
      if(rect.height>100)break;
      if(rect.height<32||rect.width<120||seen.has(row)||row.closest('.vkms-row-anchor'))continue;
      const token=crypto.randomUUID(),previous=row.getAttribute('data-vkms-row');
      row.setAttribute('data-vkms-row',token);
      try{
        const id=identifyRow(token);
        if(!/^-?\d+_\d+(?:_[a-zA-Z0-9-]{1,128})?$/.test(id))throw Error('Invalid audio');
        row.setAttribute('data-vkms-search-row','');seen.add(row);result.push(token);break;
      }catch{
        if(previous===null)row.removeAttribute('data-vkms-row');else row.setAttribute('data-vkms-row',previous);
      }
    }
    if(result.length>=200)break;
  }
  return result;
}

// Read the actual player's selection at click time; never infer a track from its title.
function identifyPlayingTrack(){
  const player=window.ap;
  if(!player||typeof player.getCurrentAudio!=='function')throw Error('Плеер ещё не выбрал трек. Включи песню и повтори.');
  if(player.ads?.isActive)throw Error('Сейчас играет реклама. Дождись песни.');
  const audio=player.getCurrentAudio();
  const owner=Array.isArray(audio)?audio[1]:audio?.owner_id??audio?.ownerId;
  const id=Array.isArray(audio)?audio[0]:audio?.id;
  const key=Array.isArray(audio)?audio[24]:audio?.access_key;
  if(!/^-?\d{1,19}$/.test(String(owner))||!/^\d{1,19}$/.test(String(id)))throw Error('Не удалось определить текущий трек плеера.');
  return String(owner)+'_'+String(id)+(typeof key==='string'&&/^[a-zA-Z0-9-]{1,128}$/.test(key)?'_'+key:'');
}

async function startDownload(value,progressTarget=null) {
  await ready;
  const id=parseTrack(value);
  if(resolving) throw Error('Сейчас получаю адрес предыдущего трека. Подожди несколько секунд.');
  preview?.abort();
  const controller=new AbortController();
  const job={key:crypto.randomUUID(),id,state:'resolving',message:'Получаю адрес аудио…',logs:[],created:Date.now()};
  resolving={job,controller,progressTarget};
  const timeout=setTimeout(()=>controller.abort(Error('ВК не ответил за 30 секунд. Повтори попытку.')),30000);
  try {
    await changeJobs(jobs=>[job,...jobs]);
    const {lastRequest=0}=await chrome.storage.session.get('lastRequest');
    const delay=Math.max(0,1600-(Date.now()-lastRequest));
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    controller.signal.throwIfAborted();
    await chrome.storage.session.set({lastRequest:Date.now()});
    const logs=[];
    let audio;
    try{audio=await resolveTrack(id,{signal:controller.signal,onLog:message=>logs.push(message)});}
    catch(error){
      if(error.code!=='TRACK_UNAVAILABLE')throw error;
      await log(job,'Без входа трек недоступен. Проверяю текущий сеанс в открытой вкладке ВК.');
      audio=await resolveWithSession(id,controller.signal,message=>logs.push(message));
    }
    for(const message of logs)await log(job,message);
    clearTimeout(timeout);
    await log(job,'Получаю полный MP3 и проверяю файл перед сохранением.');
    await log(job,'Аудиосервер: '+new URL(audio.url).hostname);
    await ensureBuffer();
    const onAbort=()=>chrome.runtime.sendMessage({target:'audio-buffer',type:'cancel-buffer',key:job.key}).catch(()=>{});
    controller.signal.addEventListener('abort',onAbort,{once:true});
    let buffered;
    try{
      controller.signal.throwIfAborted();
      buffered=await chrome.runtime.sendMessage({target:'audio-buffer',type:'fetch-buffer',key:job.key,url:audio.url});
      if(!buffered?.ok&&['CDN_NETWORK','STALE_AUDIO_URL'].includes(buffered?.code)&&!controller.signal.aborted){
        await log(job,'['+buffered.code+'] Сервер '+new URL(audio.url).hostname+' не выдал MP3. Заново получаю адрес трека у ВК.');
        const refreshTimeout=setTimeout(()=>controller.abort(Error('ВК не ответил при обновлении адреса. Повтори скачивание.')),20000);
        try{
          const {lastRequest=0}=await chrome.storage.session.get('lastRequest');
          const delay=Math.max(0,1600-(Date.now()-lastRequest));
          if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
          controller.signal.throwIfAborted();
          await chrome.storage.session.set({lastRequest:Date.now()});
          const refreshLogs=[];
          audio=await refreshAudio(id,controller.signal,message=>refreshLogs.push(message));
          for(const message of refreshLogs)await log(job,message);
        }finally{clearTimeout(refreshTimeout);}
        await log(job,'Повторная попытка после проверки текущего сеанса ВК. Аудиосервер: '+new URL(audio.url).hostname);
        controller.signal.throwIfAborted();
        buffered=await chrome.runtime.sendMessage({target:'audio-buffer',type:'fetch-buffer',key:job.key,url:audio.url});
      }
      if(!buffered?.ok&&buffered?.code)await log(job,'Загрузка остановлена: '+buffered.code+'; сервер '+new URL(audio.url).hostname);
    }finally{controller.signal.removeEventListener('abort',onAbort);}
    if(!buffered?.ok)throw Error(buffered?.code==='STALE_AUDIO_URL'?'ВК повторно выдал недоступный адрес аудио. Не удалось получить MP3 даже после обновления ссылки.':buffered?.error||'Не удалось получить аудиофайл.');
    if(typeof buffered.url!=='string'||!buffered.url.startsWith('blob:'+chrome.runtime.getURL(''))||!Number.isSafeInteger(buffered.bytes)||buffered.bytes<3||buffered.bytes>MAX_AUDIO_BYTES)throw Error('Неверный ответ аудиобуфера.');
    controller.signal.throwIfAborted();
    const bytes=buffered.bytes;
    sizeCache.set(id,{bytes,time:Date.now()});
    if(sizeCache.size>200)sizeCache.delete(sizeCache.keys().next().value);
    const name=filename(audio);
    names.set(buffered.url,name);
    if(names.size>40)names.delete(names.keys().next().value);
    await update(job,{name,bytes,message:'Начинаю загрузку '+name});
    const downloadId=await chrome.downloads.download({url:buffered.url,filename:name,saveAs:false,conflictAction:'uniquify'});
    await update(job,{downloadId,state:'downloading',message:'Скачивается: '+name});
    const [download]=await chrome.downloads.search({id:downloadId});
    if(download?.state==='complete'){await update(job,{state:'complete',message:'Готово: '+download.filename});await releaseBuffer(job.key);}
    else if(download?.state==='interrupted'){await update(job,{state:'error',message:'Chrome прервал сохранение: '+(download.error||'ошибка диска')});await releaseBuffer(job.key);}
    return {ok:true,key:job.key,downloadId,bytes};
  } catch(error) {
    await releaseBuffer(job.key);
    const message=controller.signal.aborted ? String(controller.signal.reason?.message||'Отменено.') : error instanceof TypeError ? 'Не удалось связаться с ВК или аудиосервером. Проверь соединение и повтори попытку.' : String(error.message||error);
    await update(job,{state:'error',message});
    return {ok:false,key:job.key,error:message};
  } finally {
    clearTimeout(timeout);resolving=null;
  }
}

chrome.action.onClicked.addListener(async()=>{
  const url=chrome.runtime.getURL('index.html');
  const tabs=await chrome.tabs.query({url});
  if(tabs[0])await chrome.tabs.update(tabs[0].id,{active:true});
  else await chrome.tabs.create({url});
});
chrome.downloads.onChanged.addListener(async delta=>{
  if(!delta.state || !['complete','interrupted'].includes(delta.state.current))return;
  await ready;
  const {jobs=[]}=await chrome.storage.session.get('jobs');
  const job=jobs.find(j=>j.downloadId===delta.id);if(!job)return;
  const [item]=await chrome.downloads.search({id:delta.id});
  await update(job,{state:delta.state.current==='complete'?'complete':'error',message:delta.state.current==='complete'?'Готово: '+(item?.filename||job.name):'Загрузка прервана: '+(item?.error||'ошибка сети')});
  await releaseBuffer(job.key);
});
chrome.downloads.onDeterminingFilename.addListener((item,suggest)=>{
  const name=names.get(item.url);
  if(item.byExtensionId===chrome.runtime.id && name)suggest({filename:name,conflictAction:'uniquify'});
  else suggest();
});
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id)return;
  if(message?.target==='audio-buffer')return;
  const role=senderRole(sender,chrome.runtime.id);
  if(!message||typeof message!=='object'||!allowsCommand(role,message.type)){reply({ok:false,error:'Команда недоступна этому источнику.'});return;}
  if(['cancel','show','buffer-progress'].includes(message.type)&&!validKey(message.key)){reply({ok:false,error:'Неверный идентификатор задания.'});return;}
  (async()=>{
    if(message.type==='search-rows'){
      if(!/^\/search(?:\/audio)?\/?$/.test(new URL(sender.url).pathname))throw Error('Не страница поиска музыки.');
      // executeScript functions do not share the service worker's lexical scope.
      const rows=await chrome.scripting.executeScript({target:{tabId:sender.tab.id},world:'MAIN',func:discoverSearchRowsWithIdentity});
      return {ok:true,tokens:rows[0]?.result||[]};
    }
    if(message?.type==='buffer-progress'){
      if(!Number.isSafeInteger(message.bytes)||message.bytes<0||message.bytes>MAX_AUDIO_BYTES||!Number.isSafeInteger(message.total)||message.total<0||message.total>MAX_AUDIO_BYTES)throw Error('Неверный размер аудио.');
      if(resolving?.job.key===message.key){
        const target=resolving.progressTarget;
        if(target)await chrome.tabs.sendMessage(target.tabId,{type:'vkms-download-progress',token:target.token,bytes:message.bytes,total:message.total},{frameId:0}).catch(()=>{});
        const total=message.total?' / '+(message.total/1048576).toFixed(1)+' МБ':' МБ';
        await update(resolving.job,{message:'Получено '+(message.bytes/1048576).toFixed(1)+total});
      }
      return {ok:true};
    }
    if(message?.type==='download'||message?.type==='track-size'){
      if(role==='vk'&&parseTrack(message.link)!==parseTrack(sender.url))throw Error('Ссылка не соответствует открытой странице трека.');
      return message.type==='track-size'?trackSize(message.link):startDownload(message.link);
    }
    if(message.type==='player-download'||message.type==='player-size'){
      if(!validKey(message.token))throw Error('Неверный идентификатор загрузки.');
      const [selected]=await chrome.scripting.executeScript({target:{tabId:sender.tab.id},world:'MAIN',func:identifyPlayingTrack});
      const id=parseTrack(selected?.result);
      return message.type==='player-size'?trackSize(id):startDownload(id,{tabId:sender.tab.id,token:message.token});
    }
    if(message?.type==='row-download'||message?.type==='row-size') {
      if(!sender.tab || !/^https:\/\/(?:(?:m|www)\.)?vk\.(ru|com)\//.test(sender.tab.url||'') || !/^[a-f0-9-]{36}$/.test(message.token))throw Error('Неизвестная вкладка или строка.');
      const rows=await chrome.scripting.executeScript({target:{tabId:sender.tab.id},world:'MAIN',func:identifyRow,args:[message.token]});
      return message.type==='row-size'?trackSize(rows[0]?.result):startDownload(rows[0]?.result,{tabId:sender.tab.id,token:message.token});
    }
    if(message?.type==='cancel') {
      const {jobs=[]}=await chrome.storage.session.get('jobs');
      const job=jobs.find(j=>j.key===message.key);if(!job)return {ok:false,error:'Задание не найдено.'};
      if(resolving?.job.key===job.key)resolving.controller.abort(Error('Отменено.'));
      else if(job.downloadId!==undefined && job.state==='downloading')await chrome.downloads.cancel(job.downloadId);
      return {ok:true};
    }
    if(message?.type==='show') {
      const {jobs=[]}=await chrome.storage.session.get('jobs');
      const job=jobs.find(j=>j.key===message.key);
      if(job?.state==='complete')await chrome.downloads.show(job.downloadId);
      return {ok:true};
    }
    throw Error('Неизвестная команда.');
  })().then(reply,error=>reply({ok:false,error:String(error.message||error)}));
  return true;
});
