import {setAudioAdBlock} from './adblock.js';
const $=id=>document.getElementById(id);
let submitting=false;
let generation=0;
let collapsed=false;
const pageJobs=new Set();
// History belongs to the background download manager; each opened page starts fresh.
const initialized=chrome.storage.session.get('jobs').then(({jobs=[]})=>new Set(jobs.map(job=>job.key)));
$('link').value='';
function button(text,action) {
  const el=document.createElement('button');el.textContent=text;el.type='button';
  el.addEventListener('click',async()=>{el.disabled=true;try{await action();}catch(e){$('status').textContent=e.message;}finally{el.disabled=false;}});
  return el;
}
async function render() {
  const current=++generation;
  const previousJobs=await initialized;
  const {jobs:allJobs=[]}=await chrome.storage.session.get('jobs');
  if(current!==generation)return;
  const jobs=allJobs.filter(job=>!previousJobs.has(job.key));
  for(const job of jobs)if(!pageJobs.has(job.key)){pageJobs.add(job.key);collapsed=false;}
  $('toggle-list').hidden=!jobs.length;
  $('toggle-list').textContent=collapsed?'Показать список ('+jobs.length+')':'Скрыть список';
  $('toggle-list').setAttribute('aria-expanded',String(!collapsed));
  $('jobs').hidden=collapsed;
  const frag=document.createDocumentFragment();
  for(const job of jobs) {
    const box=document.createElement('article');box.className='job';box.dataset.state=job.state;
    const body=document.createElement('div');body.className='job-body';
    const title=document.createElement('strong');title.textContent=job.name||job.id;body.append(title);
    const msg=document.createElement('p');msg.className='meta';
    msg.textContent=job.state==='complete'?'Скачано'+(job.bytes?' · '+(job.bytes/1048576).toFixed(2)+' МБ':''):job.message;
    body.append(msg);box.append(body);
    const actions=document.createElement('div');actions.className='job-actions';
    if(job.state==='complete')actions.append(button('Показать файл',()=>chrome.runtime.sendMessage({type:'show',key:job.key})));
    if(['resolving','downloading'].includes(job.state))actions.append(button('Отмена',()=>chrome.runtime.sendMessage({type:'cancel',key:job.key})));
    if(job.state==='error')actions.append(button('Повторить',async()=>{const result=await chrome.runtime.sendMessage({type:'download',link:job.id});if(!result.ok)throw Error(result.error);}));
    box.append(actions);
    if(job.logs?.length){const detail=document.createElement('details'),summary=document.createElement('summary'),log=document.createElement('pre');detail.className='job-log';summary.textContent='Подробности';log.textContent=job.message+'\n\n'+job.logs.join('\n');detail.append(summary,log);box.append(detail);}
    frag.append(box);
  }
  if(!frag.childNodes.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='Здесь появятся новые загрузки.';frag.append(empty);}
  $('jobs').replaceChildren(frag);
}
$('form').addEventListener('submit',async event=>{
  event.preventDefault();if(submitting)return;
  await initialized;
  submitting=true;$('start').disabled=true;$('status').textContent='Получаю файл…';
  try {
    const result=await chrome.runtime.sendMessage({type:'download',link:$('link').value});
    $('status').textContent=result.ok?'Загрузка передана Chrome.':result.error;
  } catch(e) {$('status').textContent='Ошибка расширения: '+e.message;}
  finally{submitting=false;$('start').disabled=false;await render();}
});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='session'&&changes.jobs)render();});
$('toggle-list').addEventListener('click',()=>{collapsed=!collapsed;render();});
window.addEventListener('pageshow',()=>{$('link').value='';});
render();


function applySettings(values){
  $('dark-theme').checked=values.darkTheme!==false;
  $('speed-enabled').checked=values.speedPanelEnabled!==false;
  $('notifications-enabled').checked=values.notificationsEnabled!==false;
  $('adblock-test').checked=values.audioAdBlockTest===true;
  document.documentElement.dataset.theme=$('dark-theme').checked?'dark':'light';
}
chrome.storage.local.get(['darkTheme','speedPanelEnabled','notificationsEnabled','audioAdBlockTest']).then(applySettings);
$('dark-theme').addEventListener('change',()=>{document.documentElement.dataset.theme=$('dark-theme').checked?'dark':'light';chrome.storage.local.set({darkTheme:$('dark-theme').checked});});
$('speed-enabled').addEventListener('change',()=>chrome.storage.local.set({speedPanelEnabled:$('speed-enabled').checked}));
let settingsCloseTimer,settingsExitTimer,settingsAnimationFrame;
const settingsAnchor=$('settings-toggle').closest('.settings-anchor');
function positionSettings(){
  if(matchMedia('(min-width:1280px)').matches){
    const heading=document.querySelector('header>small').getBoundingClientRect(),main=document.querySelector('main').getBoundingClientRect();
    settingsAnchor.style.top=(heading.top-main.top+(heading.height-$('settings-toggle').offsetHeight)/2)+'px';
  }else settingsAnchor.style.top='0px';
  const panel=$('settings-panel');
  if(!panel.hidden){
    const anchor=settingsAnchor.getBoundingClientRect(),label=document.querySelector('.settings-label').getBoundingClientRect();
    const panelWidth=panel.offsetWidth,padding=parseFloat(getComputedStyle(panel).paddingTop);
    const titleHeight=$('settings-title').offsetHeight;
    let left=label.right+12,top=label.top+label.height/2-padding-titleHeight/2;
    const side=left+panelWidth<=innerWidth-12;
    if(!side){left=Math.max(12,Math.min(anchor.left,innerWidth-panelWidth-12));top=anchor.bottom+12;}
    top=Math.max(12,top);
    panel.dataset.placement=side?'right':'bottom';
    panel.style.left=(left-anchor.left)+'px';panel.style.top=(top-anchor.top)+'px';
    panel.style.setProperty('--settings-available-height',Math.max(120,innerHeight-top-16)+'px');
  }
}
window.addEventListener('resize',positionSettings);
const settingsLayoutObserver=new ResizeObserver(positionSettings);
settingsLayoutObserver.observe(document.querySelector('header'));
positionSettings();
function openSettings(){
  clearTimeout(settingsCloseTimer);clearTimeout(settingsExitTimer);cancelAnimationFrame(settingsAnimationFrame);
  const panel=$('settings-panel');panel.hidden=false;panel.classList.remove('is-closing');positionSettings();
  panel.getBoundingClientRect();
  settingsAnimationFrame=requestAnimationFrame(()=>panel.classList.add('is-open'));
  $('settings-toggle').setAttribute('aria-expanded','true');
}
function closeSettings(){
  clearTimeout(settingsCloseTimer);cancelAnimationFrame(settingsAnimationFrame);
  $('adblock-tip')?.classList.remove('tip-visible');
  const panel=$('settings-panel');if(panel.hidden||panel.classList.contains('is-closing'))return;
  panel.classList.remove('is-open');panel.classList.add('is-closing');$('settings-toggle').setAttribute('aria-expanded','false');
  clearTimeout(settingsExitTimer);settingsExitTimer=setTimeout(()=>{panel.hidden=true;panel.classList.remove('is-closing');},matchMedia('(prefers-reduced-motion: reduce)').matches?0:180);
}
settingsAnchor.addEventListener('pointerenter',event=>{if(event.pointerType!=='touch')openSettings();});
settingsAnchor.addEventListener('pointerleave',()=>{settingsCloseTimer=setTimeout(()=>{if(!settingsAnchor.contains(document.activeElement))closeSettings();},180);});
settingsAnchor.addEventListener('focusin',openSettings);
settingsAnchor.addEventListener('focusout',()=>{settingsCloseTimer=setTimeout(()=>{if(!settingsAnchor.contains(document.activeElement)&&!settingsAnchor.matches(':hover'))closeSettings();},0);});
// Keep a tap fallback on devices without a hover pointer.
$('settings-toggle').addEventListener('click',()=>{if(!matchMedia('(hover: hover)').matches)openSettings();});
document.addEventListener('click',event=>{if(!event.target.closest('.settings-anchor'))closeSettings();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('settings-panel').hidden){$('settings-toggle').focus();closeSettings();}});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&(changes.darkTheme||changes.speedPanelEnabled||changes.notificationsEnabled||changes.audioAdBlockTest))chrome.storage.local.get(['darkTheme','speedPanelEnabled','notificationsEnabled','audioAdBlockTest']).then(applySettings);});

$('notifications-enabled').addEventListener('change',()=>chrome.storage.local.set({notificationsEnabled:$('notifications-enabled').checked}));

$('adblock-test').addEventListener('change',async()=>{
  const toggle=$('adblock-test'),enabled=toggle.checked;toggle.disabled=true;
  try{await setAudioAdBlock(enabled);pageNotice(enabled?'Тестовая блокировка включена. Отключи блокировку DevTools и обнови вкладку ВК.':'Тестовая блокировка выключена. Обнови вкладку ВК.','test');}
  catch(error){toggle.checked=!enabled;pageNotice('Не удалось изменить блокировку: '+error.message,'error');}
  finally{toggle.disabled=false;}
});

function pageNotice(message,kind='success'){
  if(!$('notifications-enabled').checked)return;
  let stack=document.querySelector('.page-notices');
  if(!stack){stack=document.createElement('div');stack.className='page-notices';document.body.append(stack);}
  const box=document.createElement('div');box.className='page-notice';box.dataset.kind=kind;box.setAttribute('role','status');
  const mark=document.createElement('span');mark.className='page-notice-mark';mark.setAttribute('aria-hidden','true');
  mark.innerHTML=(kind==='error'||kind==='test')?'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v9"/><circle cx="12" cy="18" r="1.2" fill="currentColor" stroke="none"/></svg>':'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4.5 4.5L19 7"/></svg>';
  const text=document.createElement('span');text.className='page-notice-text';text.textContent=message;
  const close=document.createElement('button');close.type='button';close.className='page-notice-close';close.textContent='×';close.setAttribute('aria-label','Закрыть уведомление');
  let timer;
  function dismiss(){if(box.classList.contains('leaving'))return;clearTimeout(timer);box.classList.add('leaving');setTimeout(()=>box.remove(),180);}
  close.addEventListener('click',dismiss);box.append(mark,text,close);stack.prepend(box);
  while(stack.children.length>3)stack.lastElementChild.remove();
  timer=setTimeout(dismiss,kind==='error'?7000:5000);
}

const experimentalSetting=$('adblock-test').closest('.experimental-setting');
$('adblock-tip').classList.add('detached');document.body.append($('adblock-tip'));
function positionAdblockTip(){
  const tip=$('adblock-tip'),menu=$('settings-panel').getBoundingClientRect(),row=$('adblock-test').getBoundingClientRect();
  const width=Math.min(280,innerWidth-24);tip.style.width=width+'px';
  const height=tip.getBoundingClientRect().height;
  let side='right',left=menu.right+12,top=row.top+(row.height-height)/2;
  if(left+width>innerWidth-12){
    side='left';left=menu.left-width-12;
    if(left<12){side='vertical';left=Math.max(12,Math.min(menu.left,innerWidth-width-12));top=menu.bottom+12;if(top+height>innerHeight-12)top=menu.top-height-12;}
  }
  const finalTop=Math.max(12,Math.min(top,innerHeight-height-12));
  tip.dataset.side=side;tip.style.setProperty('--tip-arrow-y',Math.max(8,Math.min(height-8,row.top+row.height/2-finalTop))+'px');
  tip.style.left=Math.max(12,left)+'px';tip.style.top=finalTop+'px';
}
function showAdblockTip(){positionAdblockTip();$('adblock-tip').classList.add('tip-visible');}
experimentalSetting.addEventListener('pointerenter',showAdblockTip);
experimentalSetting.addEventListener('focusin',showAdblockTip);
experimentalSetting.addEventListener('pointerleave',()=>{if(!experimentalSetting.contains(document.activeElement))$('adblock-tip').classList.remove('tip-visible');});
experimentalSetting.addEventListener('focusout',()=>{if(!experimentalSetting.matches(':hover'))$('adblock-tip').classList.remove('tip-visible');});
$('settings-panel').querySelector('.settings-items').addEventListener('scroll',positionAdblockTip,{passive:true});
window.addEventListener('resize',()=>{if(!$('settings-panel').hidden)positionAdblockTip();});
