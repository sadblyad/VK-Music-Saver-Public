import {isMediaHost} from './core.js';
import {MAX_AUDIO_BYTES,validateMp3} from './security.js';
import {audioRequest} from './transport.js';

export async function fetchCompleteAudio(url,{signal,fetcher=fetch,onProgress=()=>{},maxBytes=MAX_AUDIO_BYTES}={}) {
  if(!isMediaHost(url))throw Error('Недопустимый аудиосервер.');
  const response=await audioRequest(url,{signal},fetcher);
  if(response.status!==200){await response.body?.cancel();throw Error('Аудиосервер ответил HTTP '+response.status+'. Повтори скачивание.');}
  if(response.url&&!isMediaHost(response.url)){await response.body?.cancel();throw Error('Аудиосервер перенаправил запрос на неизвестный сайт.');}
  const type=(response.headers.get('Content-Type')||'').toLowerCase();
  if(/text\/|json|xml/.test(type)){await response.body?.cancel();throw Error('Вместо MP3 сервер вернул страницу ошибки. Файл не сохранён. Повтори скачивание.');}
  const total=Number(response.headers.get('Content-Length'))||0;
  const limit=Math.min(MAX_AUDIO_BYTES,maxBytes);
  if(total>limit){await response.body?.cancel();throw Error('Превышен лимит памяти аудиобуфера (до 100 МБ). Загрузка остановлена.');}
  const chunks=[];let bytes=0,last=0,prefix=new Uint8Array();
  const reader=response.body.getReader();
  try{
    while(true){
      const {done,value}=await reader.read();if(done)break;
      signal?.throwIfAborted();bytes+=value.length;
      if(bytes>limit)throw Error('Превышен лимит памяти аудиобуфера (до 100 МБ). Загрузка остановлена.');
      if(prefix.length<3){const part=new Uint8Array(Math.min(3,prefix.length+value.length));part.set(prefix);part.set(value.subarray(0,3-prefix.length),prefix.length);prefix=part;}
      if(prefix.length>=3 && !(prefix[0]===73&&prefix[1]===68&&prefix[2]===51) && !(prefix[0]===255&&(prefix[1]&224)===224))throw Error('Сервер вернул файл без сигнатуры MP3. Он не сохранён. Повтори скачивание.');
      chunks.push(value);
      if(Date.now()-last>=100){last=Date.now();onProgress(bytes,total);}
    }
  }finally{await reader.cancel().catch(()=>{});}
  if(bytes<3 || (total&&bytes!==total))throw Error('Аудиофайл получен не полностью. Повтори скачивание.');
  const blob=new Blob(chunks,{type:'audio/mpeg'});
  if(!validateMp3(new Uint8Array(await blob.arrayBuffer())))throw Error('Файл не содержит корректной последовательности MP3-кадров. Он не сохранён.');
  onProgress(bytes,total||bytes);
  return blob;
}
