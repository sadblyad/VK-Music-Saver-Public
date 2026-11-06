import {fetchCompleteAudio} from './media.js';
import {senderRole,validKey,MAX_AUDIO_BYTES} from './security.js';
const tasks=new Map(),blobs=new Map();
function release(key){const blob=blobs.get(key);if(!blob)return;clearTimeout(blob.timeout);URL.revokeObjectURL(blob.url);blobs.delete(key);}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id||message?.target!=='audio-buffer')return;
  if(senderRole(sender,chrome.runtime.id)!=='worker'||!validKey(message.key)){reply({ok:false,error:'Доступ к аудиобуферу запрещён.'});return;}
  if(message.type==='release'){
    release(message.key);reply({ok:true});return;
  }
  if(message.type==='cancel-buffer'){tasks.get(message.key)?.abort();reply({ok:true});return;}
  if(message.type!=='fetch-buffer')return;
  const remaining=MAX_AUDIO_BYTES-[...blobs.values()].reduce((sum,item)=>sum+item.bytes,0);
  if(tasks.size||blobs.has(message.key)||blobs.size>=3||remaining<1024){reply({ok:false,error:'Аудиобуфер занят. Заверши сохранение предыдущего файла.'});return;}
  (async()=>{
    const controller=new AbortController();tasks.set(message.key,controller);
    const timeout=setTimeout(()=>controller.abort(),150000);
    let latestBytes=0,latestTotal=0;
    const notify=()=>chrome.runtime.sendMessage({type:'buffer-progress',key:message.key,bytes:latestBytes,total:latestTotal}).catch(()=>{});
    // Report stalled transfers too, keeping the download task alive until its timeout.
    const heartbeat=setInterval(notify,10000);
    try{
      let blob;
      for(let attempt=0;attempt<2;attempt++){
        try{
          blob=await fetchCompleteAudio(message.url,{signal:controller.signal,maxBytes:remaining,onProgress:(bytes,total)=>{latestBytes=bytes;latestTotal=total;notify();}});
          break;
        }catch(error){
          if(attempt||!(error instanceof TypeError)||controller.signal.aborted)throw error;
          await new Promise(resolve=>setTimeout(resolve,700));
        }
      }
      controller.signal.throwIfAborted();
      latestBytes=blob.size;latestTotal=blob.size;
      await notify();
      const url=URL.createObjectURL(blob);blobs.set(message.key,{url,bytes:blob.size,timeout:setTimeout(()=>release(message.key),10*60*1000)});
      return {ok:true,url,bytes:blob.size};
    }catch(error){return {ok:false,code:controller.signal.aborted?'ABORTED':error.code==='STALE_AUDIO_URL'?'STALE_AUDIO_URL':error instanceof TypeError?'CDN_NETWORK':'INVALID_AUDIO',error:controller.signal.aborted?'Скачивание отменено или превышено время ожидания.':error instanceof TypeError?'Соединение с аудиосервером прервалось. Повтори скачивание.':error.message};}
    finally{clearTimeout(timeout);clearInterval(heartbeat);tasks.delete(message.key);}
  })().then(reply,error=>reply({ok:false,error:error.message}));
  return true;
});
