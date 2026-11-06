export function isAudioUrl(value){
  try{
    if(typeof value!=='string'||value.length>8192)return false;
    const u=new URL(value);
    return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&(!u.port||u.port==='443')&&/(^|\.)vkuseraudio\.(ru|net|com)$/.test(u.hostname);
  }catch{return false;}
}
// The extension's connect-src CSP restricts every redirect hop to VK and its audio CDN.
// Some valid audio uses CDN -> vk.com/err404.php -> CDN, so a redirect is not itself an error.
export async function audioRequest(url,options={},fetcher=fetch){
  if(!isAudioUrl(url))throw Error('Недопустимый аудиосервер.');
  const response=await fetcher(url,{...options,credentials:'omit',redirect:'follow'});
  if(response.type==='opaqueredirect'||(response.status>=300&&response.status<400)){
    await response.body?.cancel();
    const error=Error('Аудиосервер перенаправляет запрос вместо выдачи MP3. Нужно обновить адрес трека.');
    error.code='STALE_AUDIO_URL';throw error;
  }
  if(response.url&&!isAudioUrl(response.url)){
    await response.body?.cancel();
    const error=Error('После перенаправления ВК не вернул аудиофайл.');error.code='STALE_AUDIO_URL';throw error;
  }
  return response;
}
