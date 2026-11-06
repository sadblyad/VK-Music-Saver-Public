import assert from 'node:assert/strict';
import {fetchCompleteAudio} from '../media.js';
const url='https://test.vkuseraudio.ru/song.mp3';
for(const response of [new Response('<html>error</html>',{headers:{'Content-Type':'text/html'}}),new Response('<html>error</html>',{headers:{'Content-Type':'audio/mpeg'}}),new Response(new Uint8Array([73,68,51,1]),{headers:{'Content-Length':'999','Content-Type':'audio/mpeg'}})]) {
 await assert.rejects(()=>fetchCompleteAudio(url,{fetcher:async()=>response}));
}
const data=new Uint8Array(834);data.set([255,251,144,0],0);data.set([255,251,144,0],417);
const blob=await fetchCompleteAudio(url,{fetcher:async()=>new Response(data,{headers:{'Content-Type':'audio/mpeg','Content-Length':String(data.length)}})});
assert.equal(blob.type,'audio/mpeg');assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),data);
const split=new ReadableStream({start(c){for(const byte of data)c.enqueue(new Uint8Array([byte]));c.close();}});
assert.equal((await fetchCompleteAudio(url,{fetcher:async()=>new Response(split)})).size,data.length);
console.log('PASS: HTML with honest and false MIME rejected; truncated audio rejected; exact audio bytes and split signature preserved');

const progress=[];
await fetchCompleteAudio(url,{fetcher:async()=>new Response(data,{headers:{'Content-Length':String(data.length)}}),onProgress:(bytes,total)=>progress.push([bytes,total])});
assert.deepEqual(progress.at(-1),[data.length,data.length]);
const unknown=[];
await fetchCompleteAudio(url,{fetcher:async()=>new Response(data),onProgress:(bytes,total)=>unknown.push([bytes,total])});
assert.deepEqual(unknown.at(-1),[data.length,data.length]);
console.log('PASS: fast download and unknown content length both report final 100%');
