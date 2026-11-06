export const MAX_AUDIO_BYTES=100*1024*1024;
export function isVkPage(value){
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&/^(?:(?:www|m)\.)?vk\.(ru|com)$/.test(u.hostname);}catch{return false;}
}
export function senderRole(sender,id){
  if(sender?.id!==id)return null;
  const root='chrome-extension://'+id+'/';
  if(sender.url===root+'index.html')return 'ui';
  if(sender.url===root+'offscreen.html'&&!sender.tab)return 'buffer';
  if(sender.url===root+'background.js'&&!sender.tab)return 'worker';
  if(sender.tab&&sender.frameId===0&&isVkPage(sender.url))return 'vk';
  return null;
}
export function allowsCommand(role,type){
  return (role==='ui'&&['download','cancel','show'].includes(type))||
    (role==='vk'&&['download','row-download','track-size','row-size','search-rows','player-download','player-size'].includes(type))||
    (role==='buffer'&&type==='buffer-progress');
}
export function validKey(value){return typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);}

// Check two consecutive MPEG Layer III frames after an optional ID3v2 tag.
export function validateMp3(bytes){
  let start=0;
  if(bytes[0]===73&&bytes[1]===68&&bytes[2]===51){
    if(bytes.length<10||bytes[3]<2||bytes[3]>4||[6,7,8,9].some(i=>bytes[i]&128))return false;
    start=10+((bytes[6]<<21)|(bytes[7]<<14)|(bytes[8]<<7)|bytes[9]);
    if(bytes[3]===4&&(bytes[5]&16))start+=10;
    if(start>16*1024*1024)return false;
  }
  function frame(at){
    if(at+4>bytes.length||bytes[at]!==255||(bytes[at+1]&224)!==224)return null;
    const version=(bytes[at+1]>>3)&3,layer=(bytes[at+1]>>1)&3;
    const index=bytes[at+2]>>4,sample=(bytes[at+2]>>2)&3,pad=(bytes[at+2]>>1)&1;
    if(version===1||layer!==1||index===0||index===15||sample===3)return null;
    const bitrate=(version===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[index];
    const rate=[44100,48000,32000][sample]/(version===3?1:version===2?2:4);
    return {length:Math.floor((version===3?144:72)*bitrate*1000/rate)+pad,version,sample};
  }
  for(let at=start;at<Math.min(start+4096,bytes.length-4);at++){
    const a=frame(at);if(!a)continue;
    const b=frame(at+a.length);
    if(b&&a.version===b.version&&a.sample===b.sample&&at+a.length+b.length<=bytes.length)return true;
  }
  return false;
}
