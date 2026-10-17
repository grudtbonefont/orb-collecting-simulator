const { chromium } = require('playwright-core'); const { spawn } = require('child_process');
const ROOT=process.cwd(), PORT=3139, URL='http://localhost:'+PORT, sleep=ms=>new Promise(r=>setTimeout(r,ms)); let f=0; const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m); if(!c)f++;};
(async()=>{ const proc=spawn(process.execPath,['server.js'],{cwd:ROOT,env:Object.assign({},process.env,{PORT:String(PORT),DATA_FILE:'/tmp/ct.json',DATABASE_URL:'',EVENT_EVERY_MS:'0',OBSTACLES:'0'}),stdio:'ignore'});
 for(let i=0;i<100;i++){try{if((await fetch(URL+'/api/health')).ok)break;}catch(_){} await sleep(200);}
 const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']}); const errs=[];
 async function join(name,mob){ const ctx=await b.newContext(Object.assign({viewport:mob?{width:390,height:844}:{width:1280,height:720}},mob?{isMobile:true,hasTouch:true}:{})); const p=await ctx.newPage(); p.on('pageerror',e=>errs.push(e.message));
  await p.goto(URL); await sleep(300); await p.click('.auth-tab[data-mode=register]'); await p.fill('#nick',name); await p.fill('#pass','demo-pass-123'); await p.fill('#pass2','demo-pass-123'); await p.click('#authSubmit');
  await p.waitForSelector('#profile:not(.hidden)'); await p.click('#pfPlay'); await p.waitForSelector('#hud:not(.hidden)'); await sleep(600); return p; }
 const st=p=>p.evaluate(()=>({chat:document.querySelectorAll('#chatLog .chat-msg').length, chatSys:document.querySelectorAll('#chatLog .chat-msg.sys').length, sys:document.querySelectorAll('#sysLog .chat-msg').length, sysNonSys:document.querySelectorAll('#sysLog .chat-msg:not(.sys)').length,
   chatVis:!document.getElementById('chatLog').classList.contains('hidden'), sysVis:!document.getElementById('sysLog').classList.contains('hidden'), form:getComputedStyle(document.getElementById('chatForm')).display!=='none',
   cb:document.getElementById('tabChatBadge').classList.contains('hidden')?0:+document.getElementById('tabChatBadge').textContent, sb:document.getElementById('tabSysBadge').classList.contains('hidden')?0:+document.getElementById('tabSysBadge').textContent, ls:localStorage.getItem('ocs_chat_tab')}));
 const A=await join('TabA'+Date.now()%1e4);
 let s=await st(A); ok(s.chatVis&&!s.sysVis&&s.form,'default: Чат tab with input');
 await A.click('#tabSys'); s=await st(A); ok(s.sysVis&&!s.chatVis&&!s.form&&s.ls==='sys','Система tab: read-only, persisted');
 const B=await join('TabB'+Date.now()%1e4); await sleep(500);
 await B.fill('#chatInput','hello from B'); await B.press('#chatInput','Enter'); await sleep(600);
 s=await st(A); ok(s.chatSys===0&&s.sysNonSys===0,'routing: sys only in Система, players only in Чат ('+s.chat+'/'+s.sys+')'); ok(s.cb>=1&&s.sb===0,'unread badge on inactive Чат tab = '+s.cb);
 await A.click('#tabChat'); s=await st(A); ok(s.chatVis&&s.cb===0,'switch to Чат clears its badge'); await A.click('#tabSys');
 await A.reload(); await sleep(1500); s=await st(A); ok(s.sysVis&&!s.form&&s.ls==='sys','tab remembered after reload');
 const M=await join('TabM'+Date.now()%1e4,true); await M.click('#chatBtn'); await sleep(300); await M.tap('#tabSys'); s=await st(M); ok(s.sysVis&&!s.form&&await M.isVisible('#tabSys'),'mobile: tabs visible & work');
 const bb=await M.locator('#tabSys').boundingBox(); ok(bb&&bb.height>=30,'mobile tab tap target '+(bb&&Math.round(bb.height)));
 // screenshots omitted
 ok(errs.length===0,'no page errors '+errs.join(';'));
 await b.close(); proc.kill(); console.log(f?'FAILED '+f:'ALL PASS'); process.exit(f?1:0); })();
