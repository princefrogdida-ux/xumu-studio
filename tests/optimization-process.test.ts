import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../apps/server/src/db/store.ts';
import { newShot } from '../packages/shared/src/index.ts';
import { MediaStore } from '../apps/server/src/storage/media.ts';
import { ExportService } from '../apps/server/src/exports/service.ts';
async function listening(port:number) {return new Promise<boolean>(resolve=>{const s=connect({host:'127.0.0.1',port});s.setTimeout(300);s.once('connect',()=>{s.destroy();resolve(true);});for(const e of ['error','timeout'])s.once(e,()=>{s.destroy();resolve(false);});});}
test('Windows dev IPC drains an accepted export, exits API/worker/Vite, and releases only its own ports',async()=>{
  const port=4381,webPort=4380;assert.equal(await listening(port),false,'隔离端口被占用，不终止占用者');assert.equal(await listening(webPort),false,'隔离端口被占用，不终止占用者');
  const dir=mkdtempSync(path.join(os.tmpdir(),'studio-ipc-')),store=new ProjectStore(path.join(dir,'studio.sqlite')),id=randomUUID(),filename=`${id}.mp4`,bytes=Buffer.alloc(32*1024*1024,29);
  let p=store.create('IPC stream');mkdirSync(path.join(dir,'media'));writeFileSync(path.join(dir,'media',filename),bytes);store.addAsset(p.id,{id,name:'large.mp4',mediaType:'video',mimeType:'video/mp4',size:bytes.length,checksum:createHash('sha256').update(bytes).digest('hex'),source:'upload',filename,thumbnail:null,createdAt:new Date().toISOString()});
  p.document.shots=[{...newShot('s',0),selectedVideoAssetId:id}];p=store.save(p.id,p.revision,p.document,p.name);store.close();
  const child=spawn(process.execPath,['scripts/dev.mjs'],{cwd:process.cwd(),env:{...process.env,STUDIO_DATA_DIR:dir,PORT:String(port),STUDIO_WEB_PORT:String(webPort),STUDIO_REAL_CALLS_ENABLED:'false'},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  let log='';child.stdout!.on('data',chunk=>{log+=chunk;});child.stderr!.on('data',chunk=>{log+=chunk;});let exited=false;const exit=new Promise<number|null>(resolve=>child.once('exit',code=>{exited=true;resolve(code);}));
  try{
    const deadline=Date.now()+15000;let ready=false;
    while(Date.now()<deadline&&!exited){try{const v=await fetch(`http://127.0.0.1:${port}/api/health`);if(v.ok&&(await v.json()).worker.status==='online'&&await listening(webPort)){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,150));}
    assert.ok(ready,log);
    const preview=await (await fetch(`http://127.0.0.1:${port}/api/projects/${p.id}/exports/preview`,{method:'POST'})).json();
    const result=await fetch(`http://127.0.0.1:${port}/api/projects/${p.id}/exports`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:p.revision,fingerprint:preview.fingerprint,allowPartial:true})});assert.equal(result.status,202);const job=await result.json();assert.equal(job.status,'building');
    child.send('shutdown');const outcome=await Promise.race([exit,new Promise<'timeout'>(resolve=>setTimeout(()=>resolve('timeout'),15000).unref())]);assert.equal(outcome,0,log);assert.equal(await listening(port),false);assert.equal(await listening(webPort),false);assert.ok(log.includes('全部开发服务正常停止'));assert.ok(!log.includes('强制停止'));
    const check=new ProjectStore(path.join(dir,'studio.sqlite')),exports=new ExportService(check,new MediaStore(path.join(dir,'media'),check),path.join(dir,'exports'));
    try{assert.equal((await exports.get(job.id)).status,'succeeded');await exports.file(job.id);}finally{check.close();}
  }finally{
    if(!exited){if(child.connected)child.send('shutdown');await Promise.race([exit,new Promise(r=>setTimeout(r,3000))]);if(!exited)child.kill();await exit;}
    rmSync(dir,{recursive:true,force:true});
  }
});
