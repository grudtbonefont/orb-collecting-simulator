const { chromium } = require('playwright-core'); const { spawn } = require('child_process');
const ROOT=process.cwd(), PORT=3138, URL='http://localhost:'+PORT, sleep=ms=>new Promise(r=>setTimeout(r,ms)); let f=0; const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m); if(!c)f++;};
(async()=>{ const proc=spawn(process.execPath,['server.js'],{cwd:ROOT,env:Object.assign({},process.env,{PORT:String(PORT),DATA_FILE:'/tmp/bgm2.json',DATABASE_URL:'',EVENT_EVERY_MS:'0',OBSTACLES:'0'}),stdio:'ignore'});
 for(let i=0;i<100;i++){try{if((await fetch(URL+'/api/health')).ok)break;}catch(_){} await sleep(200);}
 for (const n of [1,2,3]) { const r=await fetch(URL+'/audio/bg'+n+'.m4a'); ok(r.status===200, 'bg'+n+' 200'); }
 const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
 const ctx=await b.newContext(); await ctx.addInitScript(()=>{ window.__A=new Set(); window.__max=0; const P=HTMLMediaElement.prototype, op=P.play;
   P.play=function(){ __A.add(this); const r=op.call(this); setTimeout(()=>{const n=[...__A].filter(x=>!x.paused).length; if(n>__max)__max=n;},50); return r; };
   setInterval(()=>{const n=[...__A].filter(x=>!x.paused).length; if(n>__max)__max=n;},20); });
 const vp=await ctx.newPage(); const errs=[], audioReq=[]; vp.on('pageerror',e=>errs.push(e.message)); vp.on('request',r=>{if(/\/audio\//.test(r.url()))audioReq.push(r.url());});
 await vp.goto(URL); await sleep(400); for(let i=0;i<5;i++){await vp.mouse.click(10,10);} await sleep(300);
 let m=await vp.evaluate(()=>OCSMusic()); ok(m.playing===0&&audioReq.length===0, 'menu: silent, no audio requests');
 ok(await vp.evaluate(()=>!document.getElementById('menuMusic')), 'no menuMusic element');
 await vp.click('.auth-tab[data-mode=register]'); await vp.fill('#nick','Bg2T'+Date.now()%1e5); await vp.fill('#pass','demo-pass-123'); await vp.fill('#pass2','demo-pass-123'); await vp.click('#authSubmit');
 await vp.waitForSelector('#profile:not(.hidden)'); await vp.click('#pfPlay'); await vp.waitForSelector('#hud:not(.hidden)'); await sleep(1200);
 for(let i=0;i<8;i++){await vp.mouse.click(400+i,300); await vp.keyboard.press('Shift');} await sleep(300);
 m=await vp.evaluate(()=>OCSMusic()); ok(m.playing===1&&/bg\d/.test(m.bgSrc), 'game: exactly 1 playing '+m.bgSrc);
 for(let r=0;r<3;r++){ await vp.evaluate(()=>OCSMusicCtl.menu()); await sleep(150); const a=await vp.evaluate(()=>OCSMusic().playing); ok(a===0,'menu again silent #'+r);
   await vp.evaluate(()=>{OCSMusicCtl.game();OCSMusicCtl.game();OCSMusicCtl.game();}); for(let i=0;i<4;i++) await vp.mouse.click(420,320); await sleep(400);
   const g=await vp.evaluate(()=>OCSMusic().playing); ok(g===1,'re-enter game: 1 playing #'+r); }
 await vp.evaluate(()=>OCSMusic().bgNext()); await sleep(400); m=await vp.evaluate(()=>OCSMusic()); ok(m.playing===1,'next track, still 1 '+m.bgSrc);
 await vp.evaluate(()=>{const e=document.getElementById('setMusic'); e.checked=false; e.dispatchEvent(new Event('change'));}); await vp.mouse.click(300,300); await sleep(300);
 m=await vp.evaluate(()=>OCSMusic()); ok(m.playing===0&&m.muted&&await vp.evaluate(()=>localStorage.getItem('ocs_music'))==='0','toggle off silent+persisted');
 await vp.evaluate(()=>{const e=document.getElementById('setMusic'); e.checked=true; e.dispatchEvent(new Event('change'));}); await sleep(400);
 ok(await vp.evaluate(()=>OCSMusic().playing)===1,'toggle on: 1 playing');
 const mx=await vp.evaluate(()=>[window.__max,window.__A.size]); ok(mx[0]<=1,'max simultaneous playing ever = '+mx[0]+' (elements '+mx[1]+')');
 ok(!audioReq.some(u=>/menu\./.test(u)),'menu audio never requested'); ok(errs.length===0,'no page errors '+errs.join(';'));
 await b.close(); proc.kill(); console.log(f?'FAILED '+f:'ALL PASS'); process.exit(f?1:0); })();
