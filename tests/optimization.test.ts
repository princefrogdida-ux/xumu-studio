import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { ProjectStore } from '../apps/server/src/db/store.ts';
import { TaskStore } from '../apps/server/src/tasks/store.ts';
import { TaskQuery } from '../apps/server/src/tasks/query.ts';
import { TaskService } from '../apps/server/src/tasks/service.ts';
import { MediaStore } from '../apps/server/src/storage/media.ts';
import { createApp } from '../apps/server/src/api/app.ts';
import { heartbeat, health } from '../apps/server/src/health.ts';
import { ExportService, MAX_EXPORT_BYTES } from '../apps/server/src/exports/service.ts';
import { emptyDocument, newShot, type Asset } from '../packages/shared/src/index.ts';
import { prepareShot, affectedReferences, replaceMissingAsset } from '../packages/shared/src/production.ts';
import { fingerprint, resolveInput, type InputSnapshot, type Generation } from '../packages/shared/src/generation.ts';
import type { ExportJob } from '../packages/shared/src/transfer.ts';
import { useEditor } from '../apps/web/src/features/canvas/editor-store.ts';
import { useTasks } from '../apps/web/src/features/tasks/task-store.ts';
import { nodeInputView } from '../apps/web/src/features/canvas/input-view.ts';
const input: InputSnapshot = { mode:'mock', provider:'mock', kind:'script', model:'mock-script-v1', prompt:'固定文字'.repeat(2000), imageAssetIds:[], params:{shotCount:3}, scenario:'success' };
function fixture() {
  const dir=mkdtempSync(path.join(os.tmpdir(),'studio-opt-')), store=new ProjectStore(path.join(dir,'studio.sqlite'));
  const media=new MediaStore(path.join(dir,'media'),store), exports=new ExportService(store,media,path.join(dir,'exports'));
  return {dir,store,media,exports,close:async()=>{await exports.drain();store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('1000-history keyset pages exclude new inserts, contain no snapshots, and old selected generation loads by ID',()=>{
  const store=new ProjectStore(':memory:'),tasks=new TaskStore(store),query=new TaskQuery(store),p=store.create('history');
  try{
    p.document.nodes=[{id:'old-node',type:'text',position:{x:0,y:0},width:300,height:230,data:{title:'旧节点',content:'',category:'note'}}];store.save(p.id,p.revision,p.document,p.name);
    let first='';
    for(let i=0;i<1000;i++){const t=tasks.create(p.id,'old-node',`key-${i}`,input,'a'.repeat(64),null);tasks.update(t,{status:'succeeded'});if(i===0)first=t.id;}
    const g:Generation={id:randomUUID(),projectId:p.id,nodeId:'old-node',taskId:first,outputAssetIds:[],inputFingerprint:'a'.repeat(64),draft:null,createdAt:new Date().toISOString()};
    store.db.prepare('INSERT INTO generations VALUES(?,?,?,?)').run(g.id,p.id,first,JSON.stringify(g));
    const page=query.history(p.id,{});assert.equal(page.items.length,30);assert.ok(Buffer.byteLength(JSON.stringify(page))<25000);assert.ok(!JSON.stringify(page).includes(input.prompt));
    tasks.create(p.id,'old-node','new',input,'b'.repeat(64),null);
    const ids=page.items.map(t=>t.id);let cursor=page.nextCursor;
    while(cursor){const next=query.history(p.id,{cursor});ids.push(...next.items.map(t=>t.id));assert.equal(next.snapshot,page.snapshot);cursor=next.nextCursor;}
    assert.equal(ids.length,1000);assert.equal(new Set(ids).size,1000);assert.equal(query.generation(p.id,g.id).taskId,first);
    const activity=query.activity(p.id);assert.equal(activity.activeCount,1);assert.equal(activity.items.length,1);assert.ok(!JSON.stringify(activity).includes('inputSnapshot'));
    assert.throws(()=>query.history(p.id,{limit:101}));assert.throws(()=>query.history(store.create('other').id,{cursor:page.nextCursor!}));
    const plan=store.db.prepare('EXPLAIN QUERY PLAN SELECT rowid FROM tasks WHERE project_id=? ORDER BY rowid DESC LIMIT 30').all(p.id);
    assert.ok(JSON.stringify(plan).includes('tasks_project_history'));
  }finally{store.close();}
});
test('migration 5 preserves task bytes and project revision; worker heartbeats are independent of execution locks',async()=>{
  const f=fixture();let closed=false;
  try{
    const p=f.store.create('preserved'),t=new TaskStore(f.store).create(p.id,'node','key',input,'a'.repeat(64),null);
    const raw=(f.store.db.prepare('SELECT data FROM tasks WHERE id=?').get(t.id) as {data:string}).data;
    f.store.close();closed=true;const db=new DatabaseSync(path.join(f.dir,'studio.sqlite'));db.exec('DROP INDEX tasks_project_history; DROP INDEX tasks_project_status; DROP INDEX tasks_project_node; DROP TABLE worker_health; DELETE FROM migrations WHERE version=5');db.close();
    const upgraded=new ProjectStore(path.join(f.dir,'studio.sqlite'));
    try{assert.equal((upgraded.db.prepare('SELECT data FROM tasks WHERE id=?').get(t.id) as {data:string}).data,raw);assert.equal(upgraded.get(p.id).revision,p.revision);assert.equal(health(upgraded).worker.status,'stale');heartbeat(upgraded);assert.equal(health(upgraded).worker.status,'online');upgraded.db.prepare('UPDATE worker_health SET seen_at=?').run(Date.now()-21000);assert.equal(health(upgraded).worker.status,'stale');assert.equal(new TaskStore(upgraded).get(t.id).status,'queued');heartbeat(upgraded,true);assert.equal(health(upgraded).worker.status,'stopped');}finally{upgraded.close();}
  }finally{if(!closed)f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('bad/oversized/mismatched sidecars do not stop startup or open their ZIPs; valid old sidecars stay downloadable',async()=>{
  const f=fixture(),p=f.store.create('delivery');mkdirSync(f.exports.root,{recursive:true});
  const good=randomUUID(),bad=randomUUID(),large=randomUUID(),wrong=randomUUID(),bytes=Buffer.from('existing ZIP fixture');
  const job:ExportJob={id:good,projectId:p.id,revision:0,status:'succeeded',allowPartial:true,issues:[],createdAt:new Date().toISOString(),completedAt:new Date().toISOString(),size:bytes.length,checksum:createHash('sha256').update(bytes).digest('hex')};
  writeFileSync(path.join(f.exports.root,`${good}.json`),JSON.stringify(job));writeFileSync(path.join(f.exports.root,`${good}.zip`),bytes);
  writeFileSync(path.join(f.exports.root,`${bad}.json`),'{bad');writeFileSync(path.join(f.exports.root,`${bad}.zip`),bytes);
  writeFileSync(path.join(f.exports.root,`${large}.json`),' '.repeat(2*1024*1024+1));writeFileSync(path.join(f.exports.root,`${wrong}.json`),JSON.stringify(job));
  const app=createApp(f.store,undefined,f.media.root);
  try{await app.ready();assert.equal((await app.inject('/api/health')).json().invalidExportRecords,3);assert.equal((await app.inject(`/api/exports/${good}/file`)).statusCode,200);assert.equal((await app.inject(`/api/exports/${bad}/file`)).statusCode,404);assert.equal(readFileSync(path.join(f.exports.root,`${bad}.json`),'utf8'),'{bad');const history=(await app.inject(`/api/projects/${p.id}/exports`)).json();assert.equal(history.items.length,1);assert.equal(history.items[0].id,good);writeFileSync(path.join(f.exports.root,`${good}.zip`),Buffer.from('damaged ZIP fixture'));assert.equal((await app.inject(`/api/exports/${good}/file`)).statusCode,400);}finally{await app.close();await f.close();}
});
test('geometry shares unaffected records, preserves input fingerprint and one undo step, while business changes invalidate input',async()=>{
  const store=new ProjectStore(':memory:'),p=store.create('geometry');p.document.shots=[{...newShot('s',0),imagePrompt:'第一张图'}];
  p.document=prepareShot(p.document,'s','image',[]).document;useEditor.getState().load(p);
  const before=useEditor.getState(),node=before.doc.nodes.find(n=>n.type==='imageGenerate')!,hash=await fingerprint(resolveInput(before.doc,node.id,[])),version=before.inputDoc;
  before.begin();for(let i=0;i<100;i++)useEditor.getState().geometry([{id:node.id,position:{x:i,y:i}}]);useEditor.getState().viewport({x:100,y:200,zoom:.5});useEditor.getState().end();
  const after=useEditor.getState();assert.equal(after.inputDoc,version);assert.equal(after.doc.nodes[0],before.doc.nodes[0]);assert.equal(after.past.length,1);assert.equal(await fingerprint(resolveInput(after.doc,node.id,[])),hash);
  const view=nodeInputView(after.inputDoc,node.id);useEditor.getState().add('note',{x:800,y:800});assert.equal(nodeInputView(useEditor.getState().inputDoc,node.id),view);useEditor.getState().undo();
  after.undo();assert.deepEqual(useEditor.getState().doc.nodes,node?before.doc.nodes:[]);useEditor.getState().redo();assert.equal(useEditor.getState().doc.nodes.find(n=>n.id===node.id)!.position.x,99);
  useEditor.getState().editShot('s',{imagePrompt:'第二张图'});assert.notEqual(await fingerprint(resolveInput(useEditor.getState().inputDoc,node.id,[])),hash);store.close();
});
test('shot preparation is typed/idempotent/undoable and refuses ambiguous reuse or video without a selected frame',()=>{
  const store=new ProjectStore(':memory:'),p=store.create('prepare');p.document.shots=[{...newShot('s',0),imagePrompt:'镜头',videoPrompt:'运镜'}];
  const prepared=prepareShot(p.document,'s','image',[]);assert.equal(resolveInput(prepared.document,prepared.nodeId,[]).prompt,'镜头');assert.equal(prepareShot(prepared.document,'s','image',[]).document,prepared.document);
  assert.throws(()=>prepareShot(prepared.document,'s','video',[]),/选用/);const duplicate=structuredClone(prepared.document.nodes.find(n=>n.id===prepared.nodeId)!);duplicate.id=randomUUID();prepared.document.nodes.push(duplicate);assert.throws(()=>prepareShot(prepared.document,'s','image',[]),/多个/);assert.equal(prepareShot(prepared.document,'s','image',[],duplicate.id).nodeId,duplicate.id);
  useEditor.getState().load(p);useEditor.getState().update(()=>prepared.document);useEditor.getState().undo();assert.deepEqual(useEditor.getState().doc,p.document);assert.equal(new TaskStore(store).list(p.id).length,0);store.close();
});
test('missing mapping updates all current references, clears mismatched provenance, and leaves old snapshots and shared projects intact',async()=>{
  const f=fixture();
  try{
    let p=f.store.create('repair');const original=await f.media.upload(p.id,'old.png','image/png',await sharp({create:{width:8,height:8,channels:3,background:'red'}}).png().toBuffer());
    const replacement=await f.media.upload(p.id,'new.png','image/png',await sharp({create:{width:8,height:8,channels:3,background:'blue'}}).png().toBuffer());
    p.document.references=[{id:'r',kind:'character',name:'角色',description:'',assetIds:[original.id],selectedAssetId:original.id}];p.document.shots=[{...newShot('s',0),characterIds:['r'],selectedImageAssetId:original.id}];p.document=prepareShot(p.document,'s','image',[original,replacement]).document;
    p.document.nodes.push({id:'media',type:'media',position:{x:0,y:0},width:300,height:230,data:{assetId:original.id,mediaType:'image'}});p=f.store.save(p.id,p.revision,p.document,p.name);
    const shared=f.store.duplicate(p.id),tasks=new TaskStore(f.store),t=tasks.create(p.id,'old-task','key',input,'a'.repeat(64),null),snapshot=JSON.stringify(t);
    const doc=structuredClone(p.document),generationNode=doc.nodes.find(n=>n.type==='imageGenerate')!;if(generationNode.type==='imageGenerate'){generationNode.data.selectedAssetId=original.id;generationNode.data.selectedGenerationId=randomUUID();}
    const old:Asset={...original,status:'missing'};assert.equal(affectedReferences(doc,old.id).length,4);const mapped=replaceMissingAsset(doc,old,replacement);
    assert.equal(mapped.references[0].selectedAssetId,replacement.id);assert.equal(mapped.shots[0].selectedImageAssetId,replacement.id);const selected=mapped.nodes.find(n=>n.type==='imageGenerate')!;if(selected.type==='imageGenerate')assert.equal(selected.data.selectedGenerationId,null);
    useEditor.getState().load({...p,document:doc});useEditor.getState().update(()=>mapped);useEditor.getState().undo();assert.deepEqual(useEditor.getState().doc,doc);
    f.store.save(p.id,p.revision,mapped,p.name);assert.equal(f.store.get(p.id).document.shots[0].selectedImageAssetId,replacement.id);assert.equal(f.store.get(shared.id).document.shots[0].selectedImageAssetId,original.id);assert.equal(JSON.stringify(tasks.get(t.id)),snapshot);
    assert.throws(()=>replaceMissingAsset(doc,old,{...replacement,mediaType:'video'}));
  }finally{await f.close();}
});
test('front activity reads do not overlap or publish an old A response after A/B/A switching',async()=>{
  const originalFetch=globalThis.fetch,pending:{resolve:(r:Response)=>void}[]=[];globalThis.fetch=async()=>new Promise<Response>(resolve=>pending.push({resolve}));
  try{
    const a=randomUUID(),b=randomUUID(),first=useTasks.getState().load(a);assert.equal(useTasks.getState().load(a),first);const second=useTasks.getState().load(b),last=useTasks.getState().load(a);assert.equal(pending.length,3);
    pending[2].resolve(Response.json({items:[],activeCount:3}));await last;pending[0].resolve(Response.json({items:[],activeCount:1}));pending[1].resolve(Response.json({items:[],activeCount:2}));await Promise.all([first,second]);assert.equal(useTasks.getState().projectId,a);assert.equal(useTasks.getState().activeCount,3);
  }finally{globalThis.fetch=originalFetch;}
});
test('stable persistence code permits requery after Chinese error wording changes; safe logs do not echo private inputs',async()=>{
  const f=fixture(),p=f.store.create('diagnostics'),service=new TaskService(f.store,f.media),t=service.tasks.create(p.id,'n','key',input,'a'.repeat(64),null);
  const failed=service.tasks.update(t,{status:'failed',providerTaskId:'mock:durable',errorCode:'RESULT_SAVE_FAILED',error:'中文说明已经更新'});assert.equal(service.requery(failed.id).status,'running');
  const app=createApp(f.store,undefined,f.media.root),old=console.error,logs:string[]=[];console.error=(value)=>logs.push(String(value));
  try{const response=await app.inject({method:'POST',url:'/api/projects',headers:{authorization:'Bearer fake-secret'},payload:{name:'a',privateUrl:'https://private/?sig=fake-secret',prompt:'private-prompt'}});assert.equal(response.statusCode,400);assert.ok(logs[0].includes(response.headers['x-request-id'] as string));assert.ok(!logs.join('').includes('fake-secret'));assert.ok(!logs.join('').includes('private-prompt'));}finally{console.error=old;await app.close();await f.close();}
});
test('1 GiB export boundary counts repeated numbered files; streaming output and write failure stay honest',async()=>{
  const f=fixture();
  try{
    let p=f.store.create('stream');mkdirSync(f.media.root,{recursive:true});const id=randomUUID(),filename=`${id}.mp4`,bytes=Buffer.alloc(32*1024*1024,19),checksum=createHash('sha256').update(bytes).digest('hex');writeFileSync(path.join(f.media.root,filename),bytes);
    f.store.addAsset(p.id,{id,name:'stream-fixture.mp4',mediaType:'video',mimeType:'video/mp4',size:bytes.length,checksum,source:'upload',createdAt:new Date().toISOString(),filename,thumbnail:null});
    p.document.shots=[{...newShot('large',0),selectedVideoAssetId:id}];p=f.store.save(p.id,p.revision,p.document,p.name);const inspect=await f.exports.inspect(p.id),j=await f.exports.create(p.id,p.revision,inspect.preview.fingerprint,true);await f.exports.drain();const complete=await f.exports.get(j.id);assert.equal(complete.status,'succeeded');assert.ok(statSync((await f.exports.file(j.id)).file).size>bytes.length);
    const zipHash=createHash('sha256');for await(const chunk of createReadStream((await f.exports.file(j.id)).file))zipHash.update(chunk);assert.equal(zipHash.digest('hex'),complete.checksum);
    // Exact arithmetic fixture, not a claim of physically producing a 1 GiB ZIP.
    const asset=f.store.asset(id);asset.size=MAX_EXPORT_BYTES/16;f.store.db.prepare('UPDATE assets SET metadata=? WHERE id=?').run(JSON.stringify(asset),id);
    const oldInspect=f.media.inspect.bind(f.media),oldVerify=f.media.verify.bind(f.media);f.media.inspect=async a=>({...a,status:'ready'});f.media.verify=async()=>true;
    p.document.shots=Array.from({length:16},(_,i)=>({...newShot(`s-${i}`,i),selectedVideoAssetId:id}));p=f.store.save(p.id,p.revision,p.document,p.name);assert.equal((await f.exports.inspect(p.id)).preview.totalBytes,MAX_EXPORT_BYTES);
    p.document.shots.push({...newShot('overflow',16),selectedVideoAssetId:id});p=f.store.save(p.id,p.revision,p.document,p.name);await assert.rejects(f.exports.inspect(p.id),/1 GiB/);
    f.media.inspect=oldInspect;f.media.verify=oldVerify;asset.size=bytes.length;f.store.db.prepare('UPDATE assets SET metadata=? WHERE id=?').run(JSON.stringify(asset),id);p.document.shots=[{...newShot('large',0),selectedVideoAssetId:id}];p=f.store.save(p.id,p.revision,p.document,p.name);
    const internal=f.exports as unknown as {saveJob:(j:ExportJob)=>Promise<void>},save=internal.saveJob.bind(f.exports);let writes=0;internal.saveJob=async job=>{if(++writes>1)throw new Error('injected full disk');return save(job);};const preview=await f.exports.inspect(p.id),fault=await f.exports.create(p.id,p.revision,preview.preview.fingerprint,true);await f.exports.drain();assert.equal((await f.exports.get(fault.id)).status,'failed');await assert.rejects(f.exports.file(fault.id));
  }finally{await f.close();}
});
