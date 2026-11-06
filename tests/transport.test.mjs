import assert from 'node:assert/strict';
import {audioRequest} from '../transport.js';

let calls=0;
await assert.rejects(()=>audioRequest('https://evil.example/song.mp3',{},async()=>{calls++;}));
assert.equal(calls,0);
const success=new Response(new Uint8Array([1]));
Object.defineProperty(success,'url',{value:'https://cdn.vkuseraudio.ru/song.mp3'});
assert.equal(await audioRequest('https://cdn.vkuseraudio.ru/song.mp3',{credentials:'include',redirect:'manual'},async(u,o)=>{
  assert.equal(o.credentials,'omit');assert.equal(o.redirect,'follow');return success;
}),success);
for(const response of [{type:'opaqueredirect',status:0,body:null},new Response(null,{status:302})]){
  await assert.rejects(()=>audioRequest('https://cdn.vkuseraudio.ru/song.mp3',{},async()=>response),{code:'STALE_AUDIO_URL'});
}
let cancelled=false;
await assert.rejects(()=>audioRequest('https://cdn.vkuseraudio.ru/song.mp3',{},async()=>({status:200,url:'https://evil.example/song.mp3',body:{cancel:async()=>{cancelled=true;}}})),{code:'STALE_AUDIO_URL'});
assert(cancelled);
console.log('PASS: initial/final host allowlist, cancellation and forced credential/redirect policy');
