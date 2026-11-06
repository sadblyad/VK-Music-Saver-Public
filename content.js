(() => {
  const selector='[data-full-id],[data-audio-id],[data-audio],.audio_row,.audio_item,[data-testid="MusicTrackRow"],[data-testid="MusicTrackCell"],[data-testid="MusicTrackItem"],[data-testid="AudioLayer_PlaybackQueue_MusicTrackRow"],[data-testid="AudioLayer_PlaybackQueue_MusicTrackCell"],[data-testid$="_MusicTrackRow"],[data-testid$="_MusicTrackCell"],[data-testid$="_MusicTrackItem"],[data-testid="MusicAudioItem"],[data-testid="MusicAudioRow"],[class*="MusicAudioItem__root"],[class*="MusicAudioRow__root"]';
  const running=new WeakSet();
  const progressButtons=new Map();
  const playerButtons=new WeakSet();
  // Нижняя панель включена для тестирования и дальнейшей доработки.
  const DOWNLOAD_SPEED_PANEL_ENABLED=true;
  let speedVisible=true,speedStack=null;
  const speedStates=new Map(),hiddenSpeeds=new Set();
  chrome.storage.local.get('speedPanelEnabled').then(value=>{speedVisible=value.speedPanelEnabled!==false;renderSpeed();}).catch(()=>{});

  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.speedPanelEnabled){speedVisible=changes.speedPanelEnabled.newValue!==false;renderSpeed();}});
  function closeSpeed(token,animate=true){
    const state=speedStates.get(token);if(!state)return;
    clearTimeout(state.timer);clearTimeout(state.revealTimer);speedStates.delete(token);
    if(progressButtons.has(token))hiddenSpeeds.add(token);
    const panel=state.panel;
    if(panel){
      if(animate&&!matchMedia('(prefers-reduced-motion: reduce)').matches){panel.classList.add('vkms-speed-leaving');setTimeout(()=>panel.remove(),180);}
      else panel.remove();
    }
  }
  function renderSpeed(){
    if(!DOWNLOAD_SPEED_PANEL_ENABLED)return;
    if(!speedVisible){speedStack?.remove();speedStack=null;for(const state of speedStates.values())state.panel=null;return;}
    if(!speedStates.size)return;
    if(!speedStack){speedStack=document.createElement('div');speedStack.className='vkms-speed-stack';document.body.append(speedStack);}
    for(const state of speedStates.values()){
      if(state.revealAt&&performance.now()<state.revealAt)continue;
      if(!state.panel){
        const panel=document.createElement('aside');panel.className='vkms-speed';panel.setAttribute('aria-label','Скорость загрузки');
        const title=document.createElement('strong');title.className='vkms-speed-title';
        const info=document.createElement('div');info.className='vkms-speed-info';
        const progress=document.createElement('progress');progress.max=100;
        const close=document.createElement('button');close.type='button';close.className='vkms-speed-close';close.setAttribute('aria-label','Закрыть уведомление загрузки');
        close.innerHTML='<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>';
        close.addEventListener('click',()=>closeSpeed(state.token));
        panel.append(title,info,progress,close);speedStack.prepend(panel);state.panel=panel;
      }
      const panel=state.panel;
      panel.querySelector('strong').textContent=state.failed?'Загрузка остановлена':state.done?'Загрузка завершена':state.bytes?'Скачивание трека':'Получаю трек…';
      const mb=n=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(n/1048576);
      panel.querySelector('.vkms-speed-info').textContent=mb(state.bytes)+' МБ'+(state.total?' из '+mb(state.total)+' МБ':'')+' · '+mb(state.speed)+' МБ/с';
      const progress=panel.querySelector('progress');
      if(state.total)progress.value=Math.min(100,state.bytes/state.total*100);else progress.removeAttribute('value');
    }
  }
  function updateSpeed(message){
    if(!DOWNLOAD_SPEED_PANEL_ENABLED||hiddenSpeeds.has(message.token))return;
    const now=performance.now();
    let state=speedStates.get(message.token);
    // Heartbeats/metadata failures are not an actual audio transfer.
    if(!state&&message.bytes===0)return;
    if(!state){
      const retiring=speedStates.size>=3;
      while(speedStates.size>=3)closeSpeed(speedStates.keys().next().value);
      state={token:message.token,bytes:0,sampleBytes:0,total:0,speed:0,time:now,revealAt:retiring?now+190:0};speedStates.set(message.token,state);
      if(retiring)state.revealTimer=setTimeout(renderSpeed,200);
    }
    clearTimeout(state.timer);
    if(message.bytes<state.bytes){state.sampleBytes=0;state.time=now;state.speed=0;}
    const elapsed=(now-state.time)/1000;
    if(elapsed>=.2){state.speed=Math.max(0,(message.bytes-state.sampleBytes)/elapsed);state.time=now;state.sampleBytes=message.bytes;}
    state.bytes=message.bytes;state.total=message.total;renderSpeed();
  }
  chrome.runtime.onMessage.addListener((message,sender)=>{
    if(sender.id!==chrome.runtime.id||message?.type!=='vkms-download-progress')return;
    const button=progressButtons.get(message.token);
    if(!button||!running.has(button)||!Number.isSafeInteger(message.total)||message.total<0||!Number.isSafeInteger(message.bytes)||message.bytes<0)return;
    updateSpeed(message);
    if(!message.total)return;
    const ratio=Math.min(1,message.bytes/message.total);
    if(!button.querySelector('.vkms-progress-value'))button.innerHTML='<svg class="vkms-progress" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><circle class="vkms-progress-track" cx="12" cy="12" r="8"/><circle class="vkms-progress-value" cx="12" cy="12" r="8" pathLength="100" stroke-linecap="round"/></svg>';
    button.querySelector('.vkms-progress-value').style.strokeDashoffset=String(100-ratio*100);
    button.setAttribute('aria-label','Загрузка: '+Math.round(ratio*100)+'%');
  });
  let hideSubscriptionPromo=false;
  const hiddenPromos=new Set();
  function scanSubscriptionPromos(){
    for(const node of hiddenPromos)node.classList.remove('vkms-subscription-promo');
    hiddenPromos.clear();
    if(!hideSubscriptionPromo)return;
    for(const link of document.querySelectorAll('a[href*="/vk_music#"]')){
      let url;try{url=new URL(link.href,location.href);}catch{continue;}
      if(!/^https:\/\/(?:(?:www|m)\.)?vk\.(?:ru|com)$/.test(url.origin)||url.pathname!=='/vk_music')continue;
      const campaign=new URLSearchParams(url.hash.slice(1));
      if(campaign.get('utm_source')!=='Music_Promo_web'||campaign.get('utm_campaign')!=='mbquatro0rexp1gr1webretrial')continue;
      if(link.closest('.vkms-subscription-promo'))continue;
      const overlay=link.getBoundingClientRect();let container=null;
      for(let block=link.parentElement,depth=0;block&&block!==document.body&&depth<7;block=block.parentElement,depth++){
        const box=block.getBoundingClientRect();
        if(box.height>280)break;
        if(box.width<250||box.height<60)continue;
        // An overlay-sized promo container only: never hide a page, player or track collection.
        if(Math.abs(box.width-overlay.width)>32||Math.abs(box.height-overlay.height)>32)continue;
        if(block.matches('main,header,nav')||block.querySelector('[data-audio-id],[data-full-id],[data-testid="MusicTrackRow"],.audio_row'))break;
        container=block;
      }
      // The banner image/background may be a sibling of the inner text overlay.
      if(container){container.classList.add('vkms-subscription-promo');hiddenPromos.add(container);
      }
    }
  }
  chrome.storage.local.get('audioAdBlockTest').then(value=>{hideSubscriptionPromo=value.audioAdBlockTest===true;scanSubscriptionPromos();}).catch(()=>{});
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.audioAdBlockTest){hideSubscriptionPromo=changes.audioAdBlockTest.newValue===true;scanSubscriptionPromos();}});
  const owners=new WeakMap();
  function syncTheme(){
    let dark=matchMedia('(prefers-color-scheme: dark)').matches;
    for(const element of [document.body,document.documentElement]){
      const color=getComputedStyle(element).backgroundColor;
      const values=color.match(/[\d.]+/g)?.map(Number);
      if(values?.length>=3&&(values.length<4||values[3]>.5)){
        dark=(values[0]*.2126+values[1]*.7152+values[2]*.0722)<128;break;
      }
    }
    document.documentElement.dataset.vkmsTheme=dark?'dark':'light';
  }
  const themeObserver=new MutationObserver(syncTheme);
  const themeAttributes={attributes:true,attributeFilter:['class','style','data-theme','data-scheme','scheme','data-appearance']};
  themeObserver.observe(document.documentElement,themeAttributes);themeObserver.observe(document.body,themeAttributes);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change',syncTheme);
  syncTheme();
  const icon='<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m-4-4 4 4 4-4M5 17v3h14v-3"/></svg>';
  let scanTimer;
  const toastTimers=new WeakMap();
  let notificationsEnabled=true;
  function setNotifications(enabled){
    notificationsEnabled=enabled!==false;
    if(!notificationsEnabled)document.querySelectorAll('.vkms-toast').forEach(dismissToast);
  }
  chrome.storage.local.get('notificationsEnabled').then(value=>setNotifications(value.notificationsEnabled)).catch(()=>{});
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.notificationsEnabled)setNotifications(changes.notificationsEnabled.newValue);});
  let sizeTip=null,hoverButton=null,hoverTimer,hoverSequence=0;
  function hideSize(){
    clearTimeout(hoverTimer);hoverSequence++;if(sizeTip&&hoverButton?.getAttribute('aria-describedby')===sizeTip.id)hoverButton.removeAttribute('aria-describedby');hoverButton=null;sizeTip?.remove();sizeTip=null;
  }
  function positionSize(button){
    if(!sizeTip||!button.isConnected){hideSize();return;}
    const rect=button.getBoundingClientRect(),box=sizeTip.getBoundingClientRect();
    let left=rect.right+8,top=rect.top+(rect.height-box.height)/2;
    if(left+box.width>innerWidth-8){left=rect.right-box.width;top=rect.top-box.height-8;if(top<8)top=rect.bottom+8;}
    sizeTip.style.left=Math.max(8,Math.min(innerWidth-box.width-8,left))+'px';
    sizeTip.style.top=Math.max(8,Math.min(innerHeight-box.height-8,top))+'px';
  }
  function showSize(button,event){
    if(!event.isTrusted||!owners.has(button)||running.has(button))return;
    hideSize();hoverButton=button;const sequence=hoverSequence;
    hoverTimer=setTimeout(async()=>{
      if(hoverButton!==button||!button.isConnected)return;
      sizeTip=document.createElement('div');sizeTip.className='vkms-size-tip';sizeTip.id='vkms-size-'+crypto.randomUUID();sizeTip.setAttribute('role','tooltip');sizeTip.textContent='Узнаю размер…';document.body.append(sizeTip);button.setAttribute('aria-describedby',sizeTip.id);positionSize(button);
      const row=owners.get(button);let token;
      if(row){token=crypto.randomUUID();row.dataset.vkmsRow=token;}
      try{
        let result;
        const deadline=Date.now()+18000;
        for(let attempt=0;attempt<5;attempt++){
          if(sequence!==hoverSequence||hoverButton!==button||!sizeTip)return;
          result=await chrome.runtime.sendMessage(row?{type:playerButtons.has(button)?'player-size':'row-size',token}:{type:'track-size',link:location.href});
          if(result?.ok||!result?.retryable||Date.now()>=deadline)break;
          if(sequence!==hoverSequence||!sizeTip)return;
          sizeTip.textContent='Узнаю размер…';positionSize(button);
          if(attempt<4)await new Promise(resolve=>setTimeout(resolve,1200));
        }
        if(sequence!==hoverSequence||hoverButton!==button||!sizeTip)return;
        if(row&&row.dataset.vkmsRow!==token){hideSize();return;}
        sizeTip.textContent=result?.ok?new Intl.NumberFormat('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2}).format(result.bytes/1048576)+' МБ':'Сервер не сообщил размер';
      }catch{if(sequence!==hoverSequence||!sizeTip)return;sizeTip.textContent='Размер пока недоступен';}
      if(sequence===hoverSequence)positionSize(button);
    },250);
  }
  window.addEventListener('scroll',hideSize,true);window.addEventListener('resize',hideSize);
  let noticeHeader=null,noticePositionFrame;
  const noticeHeaderObserver=new ResizeObserver(()=>positionNotices());
  function positionNotices(){
    const stack=document.querySelector('.vkms-toast-stack');if(!stack)return;
    const header=document.querySelector('#page_header_cont');
    if(header!==noticeHeader){noticeHeaderObserver.disconnect();noticeHeader=header;if(header)noticeHeaderObserver.observe(header);}
    const rect=header?.getBoundingClientRect();
    const bottom=rect&&rect.width&&rect.height?Math.max(0,rect.bottom):48;
    stack.style.setProperty('--vkms-notice-top',Math.min(bottom+12,Math.max(12,innerHeight-80))+'px');
  }
  function scheduleNoticePosition(){
    cancelAnimationFrame(noticePositionFrame);noticePositionFrame=requestAnimationFrame(positionNotices);
  }
  window.addEventListener('resize',scheduleNoticePosition);
  window.addEventListener('scroll',scheduleNoticePosition,{passive:true});
  function dismissToast(box){
    if(!box||!box.isConnected||box.classList.contains('vkms-toast-leaving'))return;
    clearTimeout(toastTimers.get(box));
    box.classList.add('vkms-toast-leaving');
    setTimeout(()=>moveToasts(()=>box.remove()),200);
  }
  function moveToasts(change){
    const boxes=[...document.querySelectorAll('.vkms-toast-stack>.vkms-toast')];
    const positions=boxes.map(box=>[box,box.getBoundingClientRect().top]);
    change();
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    for(const [box,top] of positions){
      if(!box.isConnected||box.classList.contains('vkms-toast-leaving'))continue;
      const offset=top-box.getBoundingClientRect().top;
      if(offset)box.animate([{translate:'0 '+offset+'px'},{translate:'0 0'}],{duration:180,easing:'ease-out'});
    }
  }
  function toast(message,kind='loading',retryAction=null) {
    if(!notificationsEnabled)return null;
    const unavailableTrack=kind==='error'&&message==='ВК не вернул этот трек. Он может быть удалён, недоступен без входа или ограничен для твоего региона.';
    let stack=document.querySelector('.vkms-toast-stack');
    if(!stack){stack=document.createElement('div');stack.className='vkms-toast-stack';document.body.append(stack);}
    positionNotices();
    let box;
    {
      box=document.createElement('div');box.className='vkms-toast';box.setAttribute('role','status');box.setAttribute('aria-live','polite');
      const mark=document.createElement('span');mark.className='vkms-toast-mark';mark.setAttribute('aria-hidden','true');
      const body=document.createElement('div');body.className='vkms-toast-body';
      const text=document.createElement('span');text.className='vkms-toast-text';
      const retry=document.createElement('button');retry.type='button';retry.className='vkms-toast-retry';retry.textContent='Повторить';retry.hidden=true;
      body.append(text,retry);
      const close=document.createElement('button');close.type='button';close.className='vkms-toast-close';close.textContent='×';close.setAttribute('aria-label','Закрыть уведомление');
      close.addEventListener('click',()=>dismissToast(box));
      box.append(mark,body,close);
    }
    box.dataset.kind=unavailableTrack?'notice':kind;
    const mark=box.querySelector('.vkms-toast-mark');
    if(kind==='error')mark.innerHTML='<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v9"/><circle cx="12" cy="18" r="1.2" fill="currentColor" stroke="none"/></svg>';
    else if(kind==='success')mark.innerHTML='<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4.5 4.5L19 7"/></svg>';
    else mark.innerHTML='<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14m-4-4 4 4 4-4"/></svg>';
    box.querySelector('.vkms-toast-text').textContent=message;
    const retry=box.querySelector('.vkms-toast-retry');
    retry.hidden=unavailableTrack||kind!=='error'||!retryAction;
    retry.onclick=unavailableTrack?null:event=>{if(!event.isTrusted||!retryAction)return;event.preventDefault();event.stopPropagation();dismissToast(box);retryAction();};
    moveToasts(()=>stack.prepend(box));
    toastTimers.set(box,setTimeout(()=>dismissToast(box),unavailableTrack?3000:kind==='error'?7000:5000));
    return box;
  }
  function makeButton(row=null) {
    const button=document.createElement('button');button.type='button';button.className='vkms-download';button.innerHTML=icon;button.setAttribute('aria-label','Скачать этот трек');
    owners.set(button,row);
    button.addEventListener('pointerenter',event=>showSize(button,event));
    button.addEventListener('pointerleave',()=>{if(hoverButton===button)hideSize();});
    button.addEventListener('focus',event=>showSize(button,event));
    button.addEventListener('blur',()=>{if(hoverButton===button)hideSize();});
    return button;
  }
  async function runDownload(button) {
      hideSize();
      if(!button.isConnected){toast('Строка трека изменилась. Нажми значок загрузки рядом с нужной песней.','error');return;}
      const row=owners.get(button);
      if(running.has(button))return;
      running.add(button);button.disabled=true;button.setAttribute('aria-busy','true');button.setAttribute('aria-label','Получаю трек');button.innerHTML='<svg class="vkms-spinner" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 4a8 8 0 1 1-8 8"/></svg>';
      let loadingNotice,progressToken;
      try {
        let message;
        if(row){const token=crypto.randomUUID();row.dataset.vkmsRow=token;progressToken=token;progressButtons.set(token,button);message={type:playerButtons.has(button)?'player-download':'row-download',token};}
        else message={type:'download',link:location.href};
        loadingNotice=toast('Получаю трек…');
        const result=await chrome.runtime.sendMessage(message);
        if(!result?.ok)throw Error(result?.error||'Не удалось начать загрузку.');
        if(progressToken&&Number.isSafeInteger(result.bytes)&&result.bytes>0)updateSpeed({token:progressToken,bytes:result.bytes,total:result.bytes});
        dismissToast(loadingNotice);
        toast('Скачивание началось. Файл — в загрузках Chrome.','success');
      } catch(e){
        if(speedStates.has(progressToken))speedStates.get(progressToken).failed=true;
        dismissToast(loadingNotice);
        const invalid=e.message.includes('Extension context invalidated');
        const token=row?.dataset.vkmsRow;
        toast(invalid?'Расширение обновлено. Обнови вкладку ВК.':e.message,'error',invalid?null:()=>{
          if(row&&(!row.isConnected||row.dataset.vkmsRow!==token)){toast('Строка трека изменилась. Нажми значок загрузки рядом с нужной песней.','error');return;}
          // Let the old notice finish its exit before showing the new request.
          setTimeout(()=>runDownload(button),210);
        });
      }
      finally{if(progressToken)progressButtons.delete(progressToken);hiddenSpeeds.delete(progressToken);if(speedStates.has(progressToken)){const state=speedStates.get(progressToken);state.done=true;renderSpeed();state.timer=setTimeout(()=>closeSpeed(progressToken),5000);}running.delete(button);button.disabled=false;button.removeAttribute('aria-busy');button.setAttribute('aria-label','Скачать этот трек');button.innerHTML=row?icon:icon+'<span>Скачать трек</span>';}
  }
  window.addEventListener('click',event=>{
      const button=event.target.closest?.('.vkms-download');
      if(!button || !owners.has(button)||!event.isTrusted)return;
      event.preventDefault();event.stopImmediatePropagation();
      runDownload(button);
  },true);
  for(const type of ['pointerdown','mousedown','dblclick'])window.addEventListener(type,event=>{
    const button=event.target.closest?.('.vkms-download');
    if(button && owners.has(button))event.stopImmediatePropagation();
  },true);
  function place(row,button) {
    // Keep a stable gutter outside VK's hover-only and playback-specific actions.
    row.classList.add('vkms-row-anchor');button.classList.add('vkms-fallback');
    if(button.parentElement!==row)row.append(button);
  }
  function scanHeaderPlayer(){
    const header=document.querySelector('#page_header_cont');if(!header)return;
    const anchor=header.querySelector('#top_audio_layer_place,#web_spa_top_audio_player');if(!anchor)return;
    const slot=anchor.closest('li')||anchor.parentElement;
    if(!slot||!header.contains(slot))return;
    const rect=slot.getBoundingClientRect();
    if(rect.height<20||rect.height>70||rect.width>700)return;
    let button=slot.querySelector('.vkms-header-download');
    // The idle mini-player has controls but no track title.
    const hasTrack=[...slot.childNodes].some(node=>node!==button&&node.textContent?.trim());
    if(!hasTrack){if(button&&!running.has(button))button.remove();return;}
    if(!button){
      button=makeButton(slot);button.classList.add('vkms-player-download','vkms-header-download');playerButtons.add(button);slot.append(button);
    }
    slot.setAttribute('data-vkms-header-player','');
  }
  function scanPlayer(){
    const candidates=document.querySelectorAll('button[aria-label],[role="button"][aria-label],[data-testid*="dislike" i]');
    for(const element of candidates){
      const label=element.getAttribute('aria-label')||'',testid=element.getAttribute('data-testid')||'';
      if(!/dislike/i.test(testid)&&!/не нравится|не рекомендовать|dislike/i.test(label))continue;
      const dislike=element.closest('button,[role="button"]')||element;
      if(dislike.closest(selector)||dislike.closest('#page_header_cont'))continue;
      let root=null;
      for(let node=dislike.parentElement,depth=0;node&&node!==document.body&&depth<7;node=node.parentElement,depth++){
        const box=node.getBoundingClientRect();
        if(box.height>140)break;
        if(box.width>=360&&box.height>=40&&node.querySelectorAll('button,[role="button"]').length>=4){root=node;break;}
      }
      if(!root)continue;
      root.setAttribute('data-vkms-player-root','');
      let button=root.querySelector('.vkms-player-download');
      if(!button){button=makeButton(root);button.classList.add('vkms-player-download');playerButtons.add(button);}
      if(button.parentElement!==dislike.parentElement||button.nextElementSibling!==dislike)dislike.before(button);
      const nativeBox=dislike.getBoundingClientRect(),nativeIcon=dislike.querySelector('svg')?.getBoundingClientRect();
      const bounded=(value,fallback)=>Number.isFinite(value)&&value>=16&&value<=48?value:fallback;
      button.style.setProperty('--vkms-player-control-width',bounded(nativeBox.width,24)+'px');
      button.style.setProperty('--vkms-player-control-height',bounded(nativeBox.height,24)+'px');
      button.style.setProperty('--vkms-player-icon-size',bounded(nativeIcon?.width,24)+'px');

    }
  }
  let searchScanRunning=false;
  async function scanSearch(){
    if(searchScanRunning||!/^\/search(?:\/audio)?\/?$/.test(location.pathname))return;
    searchScanRunning=true;
    try{
      const result=await chrome.runtime.sendMessage({type:'search-rows'});
      if(result?.ok)for(const token of result.tokens||[]){
        if(!/^[a-f0-9-]{36}$/.test(token))continue;
        const row=document.querySelector('[data-vkms-row="'+token+'"]');
        if(row&&!row.querySelector('.vkms-download'))place(row,makeButton(row));
      }
    }catch{}finally{searchScanRunning=false;}
  }
  function scan() {
    scanSubscriptionPromos();
    positionNotices();
    scanPlayer();
    scanHeaderPlayer();
    const rows=new Set(document.querySelectorAll(selector));
    // Search also renders compact link-based cells without the catalog row markers.
    for(const link of document.querySelectorAll('a[href*="/audio"]')){
      let url;try{url=new URL(link.href,location.href);}catch{continue;}
      if(url.origin!==location.origin||!/^\/audio-?\d+_\d+(?:_[a-zA-Z0-9-]{1,128})?\/?$/.test(url.pathname))continue;
      if(link.closest(selector))continue;
      for(let row=link,depth=0;row&&row!==document.body&&depth<5;row=row.parentElement,depth++){
        const rect=row.getBoundingClientRect();
        if(rect.height>100)break;
        if(rect.height<32||rect.width<120||!/\d{1,3}:\d{2}/.test(row.textContent))continue;
        const ids=new Set([...row.querySelectorAll('a[href*="/audio"]')].map(a=>a.getAttribute('href')));
        if(row===link)ids.add(link.getAttribute('href'));
        if(ids.size!==1)break;
        rows.add(row);break;
      }
    }
    rows.forEach(row=>{
      if(row.closest('[data-vkms-player-root],[data-vkms-header-player]'))return;
      const bounds=row.getBoundingClientRect();
      // Audio metadata can also live on cover art and carousel containers.
      // Only decorate a full, compact track row, never its thumbnail or collection.
      if(bounds.width<120||bounds.height<32||bounds.height>100)return;
      // Nested wrappers must not introduce duplicate buttons for one audio row.
      for(let parent=row.parentElement;parent;parent=parent.parentElement)if(rows.has(parent))return;
      const button=row.querySelector('.vkms-download')||makeButton(row);
      place(row,button);
    });
    const pageId=/^\/audio-?\d+_\d+(?:_[a-zA-Z0-9-]{1,128})?\/?$/.test(location.pathname);
    let page=document.querySelector('.vkms-page');
    if(pageId&&!page){page=makeButton();page.classList.add('vkms-page');page.innerHTML=icon+'<span>Скачать трек</span>';document.body.append(page);}
    if(!pageId&&page)page.remove();
    scanSearch();
  }
  function schedule(){clearTimeout(scanTimer);scanTimer=setTimeout(scan,180);}
  new MutationObserver(mutations=>{
    if(mutations.some(m=>[...m.addedNodes,...m.removedNodes].some(n=>n.nodeType===1&&!n.matches?.('.vkms-download,.vkms-toast'))))schedule();
    if(mutations.some(m=>m.type==='attributes'))schedule();
  }).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['href','data-full-id','data-audio-id','data-audio','data-testid','aria-label']});
  // VK navigation is an SPA; detect URL-only transitions too.
  let href=location.href;setInterval(()=>{if(location.href!==href){href=location.href;schedule();}},1000);
  scan();
})();
