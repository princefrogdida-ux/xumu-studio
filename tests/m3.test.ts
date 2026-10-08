import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { ProjectStore } from '../apps/server/src/db/store.ts';
import { MediaStore } from '../apps/server/src/storage/media.ts';
import { TaskService } from '../apps/server/src/tasks/service.ts';
import { TaskWorker } from '../apps/server/src/worker/runner.ts';
import { MockProvider } from '../apps/server/src/providers/mock.ts';
import { createApp } from '../apps/server/src/api/app.ts';
import { emptyDocument, newShot, type GenerationNode, type Project } from '../packages/shared/src/index.ts';
import { applyDraft, fingerprint, mockCapabilities, resolveInput, selectGeneration, type Task } from '../packages/shared/src/generation.ts';
import { useEditor } from '../apps/web/src/features/canvas/editor-store.ts';

function node(type:GenerationNode['type']='imageGenerate',id=randomUUID()):GenerationNode {
  return {id,type,position:{x:0,y:0},width:320,height:300,data:{title:'测试',prompt:'雨夜，林夏走进照相馆。她发现一封信。旧友抬起头。',model:mockCapabilities.models[type==='script'?'script':type==='imageGenerate'?'image':'video'],ratio:'16:9',duration:5,count:2,shotCount:3,scenario:'success',shotId:null,selectedGenerationId:null,selectedAssetId:null}};
}
function fixture() {
  const dir=mkdtempSync(path.join(os.tmpdir(),'studio-m3-')),filename=path.join(dir,'studio.sqlite');
  const store=new ProjectStore(filename),media=new MediaStore(path.join(dir,'media'),store),service=new TaskService(store,media),provider=new MockProvider(store,0),worker=new TaskWorker(service.tasks,provider,media,0);
  let p=store.create('M3'); const n=node();p.document.nodes=[n];p=store.save(p.id,p.revision,p.document,p.name);
  const submit=async(nodeId=n.id)=>{const preview=await service.preview(p.id,nodeId);return service.submit(p.id,{nodeId,requestKey:randomUUID(),revision:preview.revision,inputFingerprint:preview.inputFingerprint});};
  return {dir,filename,store,media,service,provider,worker,p,n,submit,close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
const countJobs=(f:ReturnType<typeof fixture>)=>(f.store.db.prepare('SELECT COUNT(*) AS n FROM mock_jobs').get() as {n:number}).n;
async function finish(f:ReturnType<typeof fixture>,id:string) {
  for(let i=0;i<15 && !['succeeded','failed','unknown'].includes(f.service.tasks.get(id).status);i++){await f.worker.tick();f.service.tasks.update(f.service.tasks.get(id),{nextPollAt:0});}
  return f.service.tasks.get(id);
}

test('concurrent API/worker database initialization serializes migrations on Windows',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'m3-concurrent-')),file=path.join(dir,'studio.sqlite');
  const run=()=>new Promise<void>((resolve,reject)=>{
    const code="import { ProjectStore } from './apps/server/src/db/store.ts'; const store = new ProjectStore(process.env.STUDIO_TEST_DB_PATH); store.close();";
    const processChild=spawn(process.execPath,['--import','tsx','--input-type=module','--eval',code],{cwd:process.cwd(),env:{...process.env,STUDIO_TEST_DB_PATH:file},windowsHide:true,stdio:['ignore','ignore','pipe']});
    let stderr='';processChild.stderr?.on('data',chunk=>{stderr+=chunk;});processChild.on('error',reject);processChild.on('exit',exit=>exit===0?resolve():reject(new Error(stderr)));
  });
  try {await Promise.all([run(),run()]);const store=new ProjectStore(file);try{assert.equal((store.db.prepare('SELECT MAX(version) AS n FROM migrations').get() as {n:number}).n,5);}finally{store.close();}}
  finally {rmSync(dir,{recursive:true,force:true});}
});

test('M3 API idempotency deduplicates concurrent requests, rejects reused keys and stale summaries; snapshots stay fixed',async()=>{
  const f=fixture(),app=createApp(f.store,undefined,f.media.root);
  try {
    const preview=await f.service.preview(f.p.id,f.n.id),body={nodeId:f.n.id,requestKey:randomUUID(),revision:preview.revision,inputFingerprint:preview.inputFingerprint};
    const [a,b]=await Promise.all([app.inject({method:'POST',url:`/api/projects/${f.p.id}/tasks`,payload:body}),app.inject({method:'POST',url:`/api/projects/${f.p.id}/tasks`,payload:body})]);
    assert.equal(a.statusCode,201);assert.equal(b.statusCode,201);assert.equal(a.json<Task>().id,b.json<Task>().id);
    assert.equal(f.service.tasks.list(f.p.id).length,1);
    assert.equal((await app.inject({method:'POST',url:`/api/projects/${f.p.id}/tasks`,payload:{...body,nodeId:'other'}})).statusCode,409);
    const p=f.store.get(f.p.id);(p.document.nodes[0] as GenerationNode).data.prompt='运行中编辑的新文字';f.store.save(p.id,p.revision,p.document,p.name);
    const task=a.json<Task>();assert.equal(f.service.tasks.get(task.id).inputSnapshot.prompt,f.n.data.prompt);
    assert.equal((await app.inject({method:'POST',url:`/api/projects/${f.p.id}/tasks`,payload:{...body,requestKey:randomUUID()}})).statusCode,409);
    assert.equal((await finish(f,task.id)).status,'succeeded');assert.equal(countJobs(f),1);
  } finally {await app.close();f.close();}
});

test('two image generations, candidate selection, video, shot output and duplication keep history separate from edits',async()=>{
  const f=fixture();try {
    const first=await f.submit();await finish(f,first.id);const second=await f.submit();await finish(f,second.id);
    const generations=f.service.tasks.generations(f.p.id);assert.equal(generations.length,2);assert.equal(f.store.assets(f.p.id).length,4);
    let p=f.store.get(f.p.id);const shot=newShot(randomUUID(),0);p.document.shots=[shot];(p.document.nodes[0] as GenerationNode).data.shotId=shot.id;
    const g=generations[0];p.document=selectGeneration(p.document,g,g.outputAssetIds[1],true);const v=node('videoGenerate');v.data.shotId=shot.id;p.document.nodes.push(v);
    p.document.edges.push({id:randomUUID(),source:f.n.id,target:v.id,sourceHandle:'image-out',targetHandle:'image-in',inputOrder:0});p=f.store.save(p.id,p.revision,p.document,p.name);
    assert.equal(p.document.shots[0].selectedImageAssetId,g.outputAssetIds[1]);
    const video=await f.submit(v.id);assert.deepEqual(video.inputSnapshot.imageAssetIds,[g.outputAssetIds[1]]);await finish(f,video.id);
    const vg=f.service.tasks.generations(p.id)[0];assert.equal(f.store.asset(vg.outputAssetIds[0]).mediaType,'video');assert.equal(f.store.asset(vg.outputAssetIds[0]).source,'mock');
    const before=f.service.tasks.list(p.id).length;
    p=f.store.get(p.id);p.document=selectGeneration(p.document,g,g.outputAssetIds[0],true);p=f.store.save(p.id,p.revision,p.document,p.name);
    assert.notEqual(await fingerprint(resolveInput(p.document,v.id,await Promise.all(f.store.assets(p.id).map(a=>f.media.inspect(a))))),video.inputFingerprint);
    assert.equal(f.service.tasks.list(p.id).length,before);assert.equal(f.service.tasks.get(video.id).inputSnapshot.imageAssetIds[0],g.outputAssetIds[1]);
    useEditor.getState().load(p);useEditor.getState().select([v.id]);useEditor.getState().remove();useEditor.getState().undo();assert.equal(f.service.tasks.list(p.id).length,before);
    const copy=f.store.duplicate(p.id);assert.equal(f.service.tasks.list(copy.id).length,0);assert.equal(f.service.tasks.generations(copy.id).length,0);assert.equal(copy.document.shots[0].selectedImageAssetId,g.outputAssetIds[0]);
    useEditor.getState().select([f.n.id]);useEditor.getState().copy();useEditor.getState().paste();assert.equal((useEditor.getState().doc.nodes.at(-1) as GenerationNode).data.selectedGenerationId,null);
  } finally {f.close();}
});

test('worker/database restart resumes querying a durable remote ID without another submit; leases exclude other workers',async()=>{
  const f=fixture();try {
    const task=await f.submit();await f.worker.tick();assert.equal(f.service.tasks.get(task.id).status,'running');
    const remoteId=f.service.tasks.get(task.id).providerTaskId;
    const store2=new ProjectStore(f.filename),service2=new TaskService(store2,new MediaStore(f.media.root,store2));
    try {
      f.service.tasks.lock('another',Date.now(),15000);const worker2=new TaskWorker(service2.tasks,new MockProvider(store2,0),new MediaStore(f.media.root,store2),0);
      assert.equal(await worker2.tick(),false);f.service.tasks.releaseLock('another');
      await worker2.tick();assert.equal(service2.tasks.get(task.id).status,'succeeded');assert.equal(service2.tasks.get(task.id).providerTaskId,remoteId);assert.equal(countJobs(f),1);
    } finally {store2.close();}
  } finally {f.close();}
});

test('actual independent worker process can be killed and restarted while the browser/API are absent',async()=>{
  const f=fixture();let child:ChildProcess|undefined;
  const stop=async()=>{if(!child||child.exitCode!==null)return;const current=child;await new Promise<void>(resolve=>{current.once('exit',()=>resolve());current.kill();});};
  const until=async(check:()=>boolean)=>{const deadline=Date.now()+15000;while(!check()){if(Date.now()>deadline)throw new Error('worker process timeout');await new Promise(r=>setTimeout(r,50));}};
  const start=()=>{child=spawn(process.execPath,['--import','tsx','apps/server/src/worker/index.ts'],{cwd:process.cwd(),env:{...process.env,STUDIO_DATA_DIR:f.dir},windowsHide:true,stdio:'ignore'});};
  try {
    const task=await f.submit();start();await until(()=>f.service.tasks.get(task.id).status==='running');const id=f.service.tasks.get(task.id).providerTaskId;
    await stop();assert.equal(f.service.tasks.get(task.id).status,'running');start();await until(()=>f.service.tasks.get(task.id).status==='succeeded');
    assert.equal(f.service.tasks.get(task.id).providerTaskId,id);assert.equal(countJobs(f),1);assert.equal(f.service.tasks.generations(f.p.id).length,1);
  } finally {await stop();f.close();}
});

test('interrupted submitting without remote ID becomes unknown and is never automatically resubmitted',async()=>{
  const f=fixture();try {
    const task=await f.submit();f.service.tasks.update(task,{status:'submitting',leaseOwner:'dead-worker',leaseUntil:Date.now()-1});
    await f.worker.tick();assert.equal(f.service.tasks.get(task.id).status,'unknown');for(let i=0;i<5;i++)await f.worker.tick();assert.equal(countJobs(f),0);
    assert.throws(()=>f.service.requery(task.id),/未找到/);assert.equal(f.service.tasks.get(task.id).status,'unknown');
  } finally {f.close();}
});

test('ambiguous submit is reconciled explicitly by the mock service; failed tasks only retry on an explicit new request',async()=>{
  const f=fixture();try {
    let p=f.store.get(f.p.id);(p.document.nodes[0] as GenerationNode).data.scenario='submit-timeout';f.store.save(p.id,p.revision,p.document,p.name);
    const task=await f.submit();assert.equal((await finish(f,task.id)).status,'unknown');assert.equal(countJobs(f),1);
    for(let i=0;i<4;i++)await f.worker.tick();assert.equal(countJobs(f),1);assert.equal(f.service.tasks.generations(p.id).length,0);
    f.service.requery(task.id);assert.equal((await finish(f,task.id)).status,'succeeded');assert.equal(countJobs(f),1);
    p=f.store.get(p.id);(p.document.nodes[0] as GenerationNode).data.scenario='failure';f.store.save(p.id,p.revision,p.document,p.name);
    const failure=await f.submit();assert.equal((await finish(f,failure.id)).status,'failed');for(let i=0;i<4;i++)await f.worker.tick();assert.equal(countJobs(f),2);
    p=f.store.get(p.id);(p.document.nodes[0] as GenerationNode).data.scenario='success';f.store.save(p.id,p.revision,p.document,p.name);
    const preview=await f.service.preview(p.id,f.n.id),retry=await f.service.submit(p.id,{nodeId:f.n.id,requestKey:randomUUID(),revision:preview.revision,inputFingerprint:preview.inputFingerprint},failure.id);
    assert.equal(retry.retryOf,failure.id);assert.notEqual(retry.id,failure.id);assert.equal((await finish(f,retry.id)).status,'succeeded');
  } finally {f.close();}
});

test('query failures stop after bounded retries and require explicit requery; queued tasks can be cancelled',async()=>{
  const f=fixture();try {
    const cancel=await f.submit();f.service.cancel(cancel.id);await f.worker.tick();assert.equal(countJobs(f),0);assert.equal(f.service.tasks.get(cancel.id).status,'cancelled');
    let p=f.store.get(f.p.id);(p.document.nodes[0] as GenerationNode).data.scenario='query-timeout';f.store.save(p.id,p.revision,p.document,p.name);
    const task=await f.submit();assert.equal((await finish(f,task.id)).status,'unknown');assert.equal(f.service.tasks.get(task.id).attempt,3);assert.equal(countJobs(f),1);
    f.service.requery(task.id);assert.equal((await finish(f,task.id)).status,'succeeded');assert.equal(countJobs(f),1);
  } finally {f.close();}
});

test('partial persistence is recoverable, reuses saved output assets and never repeats provider submit',async()=>{
  const f=fixture();try {
    const task=await f.submit(),original=f.provider.media.bind(f.provider);let failed=true;
    f.provider.media=async(input,id,index)=>{if(index===1&&failed)throw new Error('模拟磁盘暂时失败');return original(input,id,index);};
    assert.equal((await finish(f,task.id)).status,'failed');assert.match(f.service.tasks.get(task.id).error!,/保存结果失败/);assert.equal(f.store.assets(f.p.id).length,1);assert.equal(countJobs(f),1);
    failed=false;f.service.requery(task.id);assert.equal((await finish(f,task.id)).status,'succeeded');assert.equal(f.store.assets(f.p.id).length,2);assert.equal(countJobs(f),1);
  } finally {f.close();}
});

test('missing and corrupt upstream assets block downstream submission and queued execution; ordered input summary uses explicit edges',async()=>{
  const f=fixture();try {
    const task=await f.submit();await finish(f,task.id);const g=f.service.tasks.generations(f.p.id)[0];let p=f.store.get(f.p.id);p.document=selectGeneration(p.document,g,g.outputAssetIds[0]);
    const v=node('videoGenerate');p.document.nodes.push(v);p.document.edges.push({id:randomUUID(),source:f.n.id,target:v.id,sourceHandle:'image-out',targetHandle:'image-in',inputOrder:0});p=f.store.save(p.id,p.revision,p.document,p.name);
    const video=await f.submit(v.id);unlinkSync(f.media.file(f.store.asset(g.outputAssetIds[0])));
    await assert.rejects(()=>f.service.preview(p.id,v.id),/缺失或损坏/);assert.equal((await finish(f,video.id)).status,'failed');assert.equal(countJobs(f),1);
    p.document.nodes.push({...node('script'),id:'text-input'});p.document.nodes.push({id:'text',type:'text',position:{x:0,y:0},width:300,height:230,data:{title:'基础',content:'基础文字',category:'note'}});p.document.edges.push({id:randomUUID(),source:'text',target:'text-input',sourceHandle:'text-out',targetHandle:'text-in'});p=f.store.save(p.id,p.revision,p.document,p.name);
    const preview=await f.service.preview(p.id,'text-input');assert.ok(preview.inputSnapshot.prompt.startsWith('基础文字\n\n'));
  } finally {f.close();}
});

test('script output stays a preview until applied; append/replace undo preserves previous shots and invalid output is retained',async()=>{
  const f=fixture();try {
    let p=f.store.get(f.p.id);const script=node('script');p.document.nodes=[script];p.document.shots=[newShot('original',0)];p=f.store.save(p.id,p.revision,p.document,p.name);
    const task=await f.submit(script.id);assert.equal((await finish(f,task.id)).status,'succeeded');assert.equal(f.store.get(p.id).document.shots.length,1);
    const g=f.service.tasks.generations(p.id)[0];assert.equal(g.draft?.shots.length,3);
    useEditor.getState().load(f.store.get(p.id));useEditor.getState().update(d=>applyDraft(d,g.draft!,'append',randomUUID));assert.equal(useEditor.getState().doc.shots.length,4);
    useEditor.getState().undo();assert.equal(useEditor.getState().doc.shots[0].id,'original');useEditor.getState().update(d=>applyDraft(d,g.draft!,'replace',randomUUID));assert.equal(useEditor.getState().doc.shots.length,3);
    useEditor.getState().undo();assert.equal(useEditor.getState().doc.shots[0].id,'original');assert.equal(f.service.tasks.get(task.id).status,'succeeded');
    p=f.store.get(p.id);(p.document.nodes[0] as GenerationNode).data.scenario='invalid-draft';f.store.save(p.id,p.revision,p.document,p.name);
    const invalid=await f.submit(script.id);assert.equal((await finish(f,invalid.id)).status,'failed');assert.match(f.service.tasks.get(invalid.id).error!,/缺字段的测试响应/);assert.equal(f.service.tasks.generations(p.id).length,1);
  } finally {f.close();}
});

test('schemaVersion 2 migrates transactionally and preserves revision, records and data on invalid upgrades',()=>{
  for(const valid of [true,false]) {
    const dir=mkdtempSync(path.join(os.tmpdir(),'m3-migration-')),file=path.join(dir,'db.sqlite');
    try {
      const db=new DatabaseSync(file);db.exec("CREATE TABLE migrations(version INTEGER PRIMARY KEY,applied_at TEXT); INSERT INTO migrations VALUES(2,'before'); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,revision INTEGER,document TEXT,created_at TEXT,updated_at TEXT); CREATE TABLE assets(id TEXT PRIMARY KEY,metadata TEXT); CREATE TABLE project_assets(project_id TEXT,asset_id TEXT,PRIMARY KEY(project_id,asset_id));");
      const doc={...emptyDocument(),schemaVersion:valid?2:99,shots:[newShot('old',0)]};db.prepare('INSERT INTO projects VALUES(?,?,7,?,?,?)').run('old','原项目',JSON.stringify(doc),'before','before');db.close();
      if(valid){const store=new ProjectStore(file);try{const p=store.get('old');assert.equal(p.revision,7);assert.equal(p.document.schemaVersion,4);assert.equal(p.document.shots[0].id,'old');assert.equal(p.document.shots[0].selectedImageAssetId,null);}finally{store.close();}}
      else{assert.throws(()=>new ProjectStore(file));const verify=new DatabaseSync(file);try{assert.equal((verify.prepare('SELECT MAX(version) AS n FROM migrations').get() as {n:number}).n,2);assert.equal((verify.prepare('SELECT document FROM projects').get() as {document:string}).document,JSON.stringify(doc));}finally{verify.close();}}
    } finally {rmSync(dir,{recursive:true,force:true});}
  }
});
