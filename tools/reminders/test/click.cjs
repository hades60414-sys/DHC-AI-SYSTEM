// 模擬使用者按下提醒的按鈕（在看不到的測試房 dm:dhc-assistant~dhc-verify），確認小助手開出 Opus 對話，然後封存。
const BASE='http://127.0.0.1:3001', ROOM='dm:dhc-assistant~dhc-verify', KEY=`dhc.chat:${ROOM}`;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const api=async(m,u,b)=>{const r=await fetch(BASE+u,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});const t=await r.text();let j=null;try{j=JSON.parse(t)}catch{}return{status:r.status,json:j,text:t}};
(async()=>{
  const nxt=(await api('GET',`/api/assistant/next?roomId=${encodeURIComponent(ROOM)}`)); console.log('next API',nxt.status,nxt.text.slice(0,200));
  const msgs=(await api('GET','/api/user/preferences')).json.preferences[KEY].msgs;
  const btn=nxt.json?.data?.items?.[0]||'開 Opus 跑測試';
  const at=new Date(Math.max(Date.now(),Date.parse(msgs.at(-1).at)+1)).toISOString();
  const q={id:`v${Date.now().toString(36)}`,by:'dhc-verify',text:btn,at,refs:[]};
  await api('PATCH','/api/user/preferences',{[KEY]:{msgs:[...msgs,q].slice(-50)}});
  const ask=await api('POST','/api/assistant/reply',{roomId:ROOM,triggerAt:at,profileId:'dhc-verify'}); console.log('reply',ask.status);
  const t0=Date.now(); while(Date.now()-t0<600000){await sleep(5000);const run=(await api('GET',`/api/assistant/status?roomId=${encodeURIComponent(ROOM)}`)).json?.data?.running??[];if(!run.length)break;}
  const after=(await api('GET','/api/user/preferences')).json.preferences[KEY].msgs;
  const ans=after.find(m=>m.by==='dhc-assistant'&&m.replyTo===q.id); console.log('answer',Math.round((Date.now()-t0)/1000)+'s',ans&&ans.text.slice(0,200),JSON.stringify(ans?.refs));
  const ref=(ans?.refs||[]).find(x=>x.kind==='session'); if(!ref){console.log('RESULT FAIL no session');return;}
  let ok=false; for(let i=0;i<24&&!ok;i++){await sleep(5000);ok=(await api('GET',`/api/providers/sessions/${ref.id}/messages`)).text.includes('收到');}
  const arc=await api('DELETE',`/api/providers/sessions/${ref.id}`); console.log(ok?'RESULT OK session answered':'RESULT FAIL session silent','archive',arc.status);
})().catch(e=>console.log('script fail',e.message));
