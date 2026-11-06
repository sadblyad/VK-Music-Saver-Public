// URL transformation follows VK's public player encoding, not audio encryption.
// The audio ID is verified before the returned address is ever used.
import {audioRequest,isAudioUrl} from './transport.js';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0PQRSTUVWXYZO123456789+/=';

export function parseTrack(value) {
  const text = String(value || '').trim();
  if(text.length>2048)throw Error('Ссылка слишком длинная.');
  if (/^-?\d{1,19}_\d{1,19}(?:_[a-zA-Z0-9-]{1,128})?$/.test(text)) return text;
  let u;
  try { u = new URL(text); } catch { throw Error('Вставь ссылку формата https://vk.ru/audio{owner_id}_{audio_id}'); }
  if (u.protocol !== 'https:' || !/^(?:(?:www|m)\.)?vk\.(ru|com)$/.test(u.hostname) || u.username || u.password || (u.port && u.port !== '443'))
    throw Error('Нужна HTTPS-ссылка на трек ВКонтакте.');
  const match = /^\/audio(-?\d{1,19}_\d{1,19}(?:_[a-zA-Z0-9-]{1,128})?)\/?$/.exec(u.pathname);
  if (!match) throw Error('Нужна ссылка на один трек, а не поиск или плейлист.');
  return match[1];
}

function unpack(text) {
  let buffer = 0, bits = 0, result = '';
  for (const ch of text) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0 || value === 64) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) { bits -= 8; result += String.fromCharCode((buffer >>> bits) & 255); }
  }
  return result;
}

function unshuffle(text, seed) {
  const chars = [...text], indices = new Array(chars.length), n = chars.length;
  if (!n) return text;
  for (let i = n - 1; i >= 0; --i) {
    seed = ((n * (i + 1)) ^ (seed + i)) % n;
    indices[i] = seed;
  }
  for (let i = 1; i < n; ++i) {
    const j = indices[n - i - 1];
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export function decodeUrl(value, userId = 0) {
  if (typeof value !== 'string' || !value) throw Error('ВК не вернул адрес аудио.');
  if(value.length>32768)throw Error('Адрес аудио слишком длинный.');
  if (!value.includes('audio_api_unavailable')) return value;
  const extra = value.split('?extra=')[1];
  if (!extra || !extra.includes('#')) throw Error('Неизвестный формат адреса ВК.');
  const [data, operations] = extra.split('#');
  let text = unpack(data);
  for (const operation of unpack(operations).split('\t').reverse()) {
    const [cmd, argument = ''] = operation.split('\v');
    if (cmd === 'i') text = unshuffle(text, Number(argument) ^ Number(userId));
    else if (cmd === 's') text = unshuffle(text, Number(argument));
    else if (cmd === 'v') text = [...text].reverse().join('');
    else if (cmd === 'x') text = [...text].map(c => String.fromCharCode(c.charCodeAt(0) ^ argument.charCodeAt(0))).join('');
    else if (cmd === 'r') {
      const double = ALPHABET + ALPHABET;
      text = [...text].map(c => { const i = double.indexOf(c); return i < 0 ? c : double[(i - Number(argument) + double.length) % double.length]; }).join('');
    } else throw Error('ВК изменил формат адресов: неизвестная операция ' + cmd);
  }
  return text;
}

export function isMediaHost(value) {
  return isAudioUrl(value);
}

export function findAudio(response, wanted) {
  wanted=parseTrack(wanted).split('_').slice(0,2).join('_');
  const stack = [response];
  let scanned = 0;
  while (stack.length && ++scanned < 15000) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value) && value.length >= 6 && typeof value[2] === 'string' && `${value[1]}_${value[0]}` === wanted)
      return {id: wanted, url:value[2], title:String(value[3] || '').slice(0,1000), artist:String(value[4] || '').slice(0,1000), duration:Number(value[5]) || 0};
    if (!Array.isArray(value) && `${value.owner_id}_${value.id}` === wanted && typeof value.url === 'string')
      return {id:wanted, url:value.url, title:String(value.title || '').slice(0,1000), artist:String(value.artist || value.performer || '').slice(0,1000), duration:Number(value.duration) || 0};
    for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
  }
  const error=Error('ВК не вернул этот трек. Он может быть удалён, недоступен без входа или ограничен для твоего региона.');
  error.code='TRACK_UNAVAILABLE';throw error;
}

export function plainText(value) {
  const entities = {amp:'&', quot:'"', apos:"'", lt:'<', gt:'>', nbsp:' '};
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (all, code) => {
    if (!code.startsWith('#')) return entities[code.toLowerCase()] ?? all;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2),16) : Number(code.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  }).trim();
}

export function filename(audio) {
  const title = [plainText(audio.artist), plainText(audio.title)].filter(Boolean).join(' — ') || 'VK ' + audio.id;
  let name = title.replace(/[\u202a-\u202e\u2066-\u2069]/g,'').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0,160).replace(/[ .]+$/,'');
  if (!name || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = 'VK_' + name;
  return name + '.mp3';
}

export async function resolveTrack(id, {fetcher = fetch, signal, credentials = 'omit', userId=0, onLog = () => {}} = {}) {
  id = parseTrack(id);
  onLog('Запрашиваю аудиозапись по ID ' + id.split('_').slice(0,2).join('_') + (credentials === 'omit' ? ' без авторизации.' : ' через текущий сеанс ВК.'));
  const response = await fetcher('https://vk.ru/music', {
    method:'POST', credentials, signal, redirect:'error',
    headers:{'Content-Type':'application/x-www-form-urlencoded', 'X-Requested-With':'XMLHttpRequest'},
    body:new URLSearchParams({al:'1', act:'reload_audios', audio_ids:id}).toString()
  });
  if (!response.ok) throw Error('ВК ответил HTTP ' + response.status + '. Попробуй позже.');
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(response.headers.get('Content-Type') || '')?.[1] || 'utf-8';
  let raw;
  try {
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024)throw Error('Слишком большой ответ ВК.');chunks.push(value);}}
    finally{await reader.cancel().catch(()=>{});}
    raw = new TextDecoder(charset).decode(await new Blob(chunks).arrayBuffer());
  }
  catch { throw Error('Не удалось прочитать ответ ВК: неизвестная кодировка.'); }
  let data;
  try { data = JSON.parse(raw.replace(/^\s*<!--/,'')); } catch { throw Error('ВК вернул страницу вместо данных. Возможна проверка доступа или временное ограничение.'); }
  const audio = findAudio(data, id);
  const encoded=audio.url;
  audio.url = decodeUrl(encoded,userId);
  if(!isMediaHost(audio.url) && userId)audio.url=decodeUrl(encoded,0);
  if (!isMediaHost(audio.url)) throw Error('ВК не предоставил допустимый адрес аудиофайла.');
  const path = new URL(audio.url).pathname;
  if (!/\.mp3$/i.test(path)) throw Error('ВК вернул поток вместо MP3. Этот формат пока не поддерживается.');
  onLog('ID подтверждён. ' + plainText(audio.artist) + ' — ' + plainText(audio.title));
  return audio;
}

export async function audioSize(url,{fetcher=fetch,signal}={}){
  if(!isMediaHost(url))throw Error('Недопустимый аудиосервер.');
  let response;
  const headController=new AbortController();
  const abortHead=()=>headController.abort();
  signal?.addEventListener('abort',abortHead,{once:true});
  const headTimeout=setTimeout(abortHead,3000);
  try{
    signal?.throwIfAborted();
    response=await audioRequest(url,{method:'HEAD',signal:headController.signal},fetcher);
    if(response.ok && !/text\/|json|xml/i.test(response.headers.get('Content-Type')||'')){
      const bytes=Number(response.headers.get('Content-Length'));
      if(Number.isSafeInteger(bytes)&&bytes>0)return bytes;
    }
  }catch(error){if(signal?.aborted)throw error;}
  finally{clearTimeout(headTimeout);signal?.removeEventListener('abort',abortHead);await response?.body?.cancel();}
  response=await audioRequest(url,{headers:{Range:'bytes=0-0'},signal},fetcher);
  try{
    if(!response.ok||/text\/|json|xml/i.test(response.headers.get('Content-Type')||''))throw Error('Размер недоступен');
    const bytes=response.status===206?Number(/\/(\d+)$/.exec(response.headers.get('Content-Range')||'')?.[1]):Number(response.headers.get('Content-Length'));
    if(!Number.isSafeInteger(bytes)||bytes<=0)throw Error('Размер недоступен');
    return bytes;
  }finally{await response.body?.cancel();}
}
