import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { emptyDocument, type GenerationNode } from '../packages/shared/src/index.ts';
import { fingerprint, resolveInput, type Task } from '../packages/shared/src/generation.ts';
import { ProjectStore } from '../apps/server/src/db/store.ts';
import { MediaStore } from '../apps/server/src/storage/media.ts';
import { readRelayConfigs, VideoProfileSchema } from '../apps/server/src/providers/config.ts';
import { ProviderRegistry } from '../apps/server/src/providers/registry.ts';
import { isPublicAddress, validateRemote, downloadRemote, remoteRequest } from '../apps/server/src/providers/network.ts';
import { TaskService } from '../apps/server/src/tasks/service.ts';
import { TaskStore } from '../apps/server/src/tasks/store.ts';
import { TaskWorker } from '../apps/server/src/worker/runner.ts';
import { createApp } from '../apps/server/src/api/app.ts';

const KEY='sk-fake-m4-only-no-billing';
const profile=JSON.parse(readFileSync('config/video-profile.example.json','utf8'));
const shot={title:'本地协议仿真镜头',description:'雨夜的街道',framing:'中景',action:'行走',camera:'固定',dialogue:'',duration:5,imagePrompt:'雨夜街道',videoPrompt:'缓慢推进'};
function node(type:GenerationNode['type']='imageGenerate'):GenerationNode {
  return {id:randomUUID(),type,position:{x:0,y:0},width:320,height:300,data:{mode:'real',title:'本地假服务，不产生收费',model:type==='script'?'relay-text-test':type==='imageGenerate'?'relay-image-test':'relay-video-test',prompt:'雨夜来信，角色走进街道。',ratio:type==='imageGenerate'?'1:1':'16:9',duration:5,count:2,shotCount:3,scenario:'success',shotId:null,selectedGenerationId:null,selectedAssetId:null}};
}
async function fixture(type:GenerationNode['type']='imageGenerate',enabled=true) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'studio-m4-')),file=path.join(dir,'studio.sqlite');
  const png=await sharp({create:{width:32,height:32,channels:3,background:'#315b68'}}).png().toBuffer(),mp4=readFileSync('apps/server/src/fixtures/mock-video.mp4');
  const received:{method:string;url:string;body:string;authorization?:string}[]=[];
  const state={mode:'base64',queries:0,posts:0,downloads:0};let origin='';
  const server=createServer(async(req,res)=>{
    const parts:Buffer[]=[];for await(const chunk of req)parts.push(Buffer.from(chunk));const text=Buffer.concat(parts).toString('utf8');
    received.push({method:req.method!,url:req.url!,body:text,authorization:req.headers.authorization});
    if(req.method==='POST')state.posts++;
    if(state.mode==='disconnect'&&req.method==='POST'){req.socket.destroy();return;}
    if(state.mode==='secret-error'&&req.method==='POST'){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:`Bearer ${KEY} https://cdn.fake/a?token=hidden-secret`}));return;}
    res.setHeader('Content-Type','application/json');
    let body:Record<string,unknown>={};try{body=JSON.parse(text);}catch{/* multipart requests intentionally contain binary parts */}
    if(req.url==='/v1/chat/completions')res.end(JSON.stringify({choices:[{message:{content:state.mode==='invalid-draft'?`bad ${KEY} https://cdn.fake/a?token=hidden-secret`:JSON.stringify({shots:[shot,shot,shot]})}}]}));
    else if(req.url==='/v1/images/generations'||req.url==='/v1/images/edits') {
      const n=typeof body.n==='number'?body.n:Number(/name="n"\r\n\r\n(\d+)/.exec(text)?.[1]??1);
      res.end(JSON.stringify({data:Array.from({length:state.mode==='wrong-count'?1:n},(_,i)=>state.mode==='url'||state.mode==='partial-url'?{url:origin+`/media/${i}.png?signature=private-token`}:{b64_json:png.toString('base64')})}));
    } else if(req.url==='/v1/video/jobs')res.end(JSON.stringify({data:{id:'job_test'}}));
    else if(req.url==='/v1/video/jobs/job_test'){state.queries++;res.end(JSON.stringify({data:{status:state.mode==='unmapped'?'mystery':state.queries===1?'running':'completed',output_urls:[origin+'/media/test.mp4?signature=private-token']}}));}
    else if(req.url?.startsWith('/media/')) {
      state.downloads++;
      if(state.mode==='partial-url'&&req.url.startsWith('/media/1.')){res.writeHead(503);res.end('unavailable');return;}
      res.setHeader('Content-Type',req.url.includes('.mp4')?'video/mp4':'image/png');res.end(req.url.includes('.mp4')?mp4:png);
    } else if(req.url==='/redirect'){res.writeHead(302,{Location:'http://localhost:1/private'});res.end();}
    else if(req.url==='/large'){res.setHeader('Content-Length','1000');res.end(Buffer.alloc(1000));}
    else {res.writeHead(404);res.end('{}');}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const profileFile=path.join(dir,'profile.json');writeFileSync(profileFile,JSON.stringify(profile));
  const env:NodeJS.ProcessEnv={STUDIO_REAL_CALLS_ENABLED:enabled?'true':'false',STUDIO_TEXT_BASE_URL:'https://relay.example/v1',STUDIO_TEXT_API_KEY:KEY,STUDIO_TEXT_MODEL:'relay-text-test',
    STUDIO_IMAGE_BASE_URL:'https://relay.example/v1',STUDIO_IMAGE_API_KEY:KEY,STUDIO_IMAGE_MODEL:'relay-image-test',STUDIO_IMAGE_MAX_REFERENCES:'2',STUDIO_IMAGE_MAX_COUNT:'2',
    STUDIO_VIDEO_BASE_URL:'https://relay.example/v1',STUDIO_VIDEO_API_KEY:KEY,STUDIO_VIDEO_MODEL:'relay-video-test',STUDIO_VIDEO_PROFILE_FILE:profileFile,STUDIO_VIDEO_MEDIA_HOSTS:'cdn.example'};
  // HTTP/loopback is injected only by the test harness; production configuration always requires public HTTPS.
  const configs=readRelayConfigs(env);for(const c of configs){assert.equal(c.cap.configured,true);c.baseUrl=origin+'/v1';c.mediaHosts=['127.0.0.1'];}
  const store=new ProjectStore(file),media=new MediaStore(path.join(dir,'media'),store),providers=new ProviderRegistry(store,media,configs,{allowLoopbackForTests:true}),service=new TaskService(store,media,providers),worker=new TaskWorker(service.tasks,providers,media,0);
  let p=store.create('M4 本地协议仿真 · 无收费');const n=node(type);p.document.nodes=[n];p=store.save(p.id,p.revision,p.document,p.name);
  const submit=async()=>{const preview=await service.preview(p.id,n.id);return service.submit(p.id,{nodeId:n.id,requestKey:randomUUID(),revision:preview.revision,inputFingerprint:preview.inputFingerprint});};
  const finish=async(task:Task,w=worker)=>{for(let i=0;i<15&&!['succeeded','unknown','failed'].includes(service.tasks.get(task.id).status);i++){await w.tick();service.tasks.update(service.tasks.get(task.id),{nextPollAt:0});}return service.tasks.get(task.id);};
  const inputImage=async()=>{const asset=await media.upload(p.id,'reference.png','image/png',png);const fresh=store.get(p.id);fresh.document.nodes.push({id:'reference',type:'media',position:{x:400,y:0},width:300,height:230,data:{assetId:asset.id,mediaType:'image'}});fresh.document.edges.push({id:randomUUID(),source:'reference',target:n.id,sourceHandle:'image-out',targetHandle:'image-in'});store.save(p.id,fresh.revision,fresh.document,fresh.name);return asset;};
  return {dir,file,store,media,providers,service,worker,p,n,configs,env,state,received,origin,submit,finish,inputImage,
    close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));rmSync(dir,{recursive:true,force:true});}};
}

test('relay config is explicit, fail-closed, capability-only and independent per kind',()=>{
  const caps=readRelayConfigs({}).map(c=>c.cap);assert.ok(caps.every(c=>!c.configured&&!c.enabled));
  const env={STUDIO_TEXT_BASE_URL:'https://relay.example/v1',STUDIO_TEXT_API_KEY:KEY,STUDIO_TEXT_MODEL:'text-model'};
  const c=readRelayConfigs(env)[0];assert.ok(c.cap.configured);assert.equal(c.cap.enabled,false);assert.ok(!JSON.stringify(c.cap).includes(KEY));
  assert.equal(readRelayConfigs({...env,STUDIO_REAL_CALLS_ENABLED:'TRUE'})[0].cap.enabled,false);
  assert.equal(readRelayConfigs({...env,STUDIO_TEXT_BASE_URL:'http://relay.example/v1'})[0].cap.configured,false);
  const imageEnv={STUDIO_IMAGE_BASE_URL:'https://relay.example/v1',STUDIO_IMAGE_API_KEY:KEY,STUDIO_IMAGE_MODEL:'image-model',STUDIO_IMAGE_SIZES:'{"16:9":"1536x1024"}'};
  assert.equal(readRelayConfigs(imageEnv)[1].cap.configured,false);
  assert.equal(VideoProfileSchema.safeParse({...profile,input:{...profile.input,image:'__proto__.key'}}).success,false);
  assert.equal(VideoProfileSchema.safeParse({...profile,queryPath:'//evil/{id}'}).success,false);
});
test('real generation is blocked both by API and worker when the paid-call gate is closed',async()=>{
  const f=await fixture('imageGenerate',false),app=createApp(f.store,undefined,f.media.root,f.providers);
  try {
    const preview=await f.service.preview(f.p.id,f.n.id);
    const response=await app.inject({method:'POST',url:`/api/projects/${f.p.id}/tasks`,payload:{nodeId:f.n.id,requestKey:randomUUID(),revision:preview.revision,inputFingerprint:preview.inputFingerprint}});
    assert.equal(response.statusCode,400);assert.match(response.json().message,/关闭/);assert.equal(f.state.posts,0);
    const task=f.service.tasks.create(f.p.id,f.n.id,randomUUID(),preview.inputSnapshot,preview.inputFingerprint,null);
    assert.equal((await f.finish(task)).status,'failed');assert.equal(f.state.posts,0);
    const caps=(await app.inject({url:'/api/providers/capabilities'})).body;
    assert.ok(!caps.includes(KEY)&&!caps.includes(f.origin)&&!caps.includes('apiKey'));
  }finally{await app.close();await f.close();}
});
test('text compatible response becomes a validated real draft and preserves malformed diagnostics with redaction',async()=>{
  const f=await fixture('script');try {
    const task=await f.submit();assert.equal((await f.finish(task)).status,'succeeded');
    const draft=f.service.tasks.generations(f.p.id)[0].draft!;assert.equal(draft.mode,'real');assert.equal(draft.shots.length,3);assert.equal(f.store.get(f.p.id).document.shots.length,0);
    const sent=JSON.parse(f.received[0].body);assert.equal(sent.model,'relay-text-test');assert.equal(sent.stream,false);assert.match(sent.messages[0].content,/JSON/);assert.equal(sent.response_format,undefined);
    f.state.mode='invalid-draft';const invalid=await f.submit();assert.equal((await f.finish(invalid)).status,'failed');
    assert.ok(!f.service.tasks.get(invalid.id).error!.includes(KEY));assert.ok(!f.service.tasks.get(invalid.id).error!.includes('hidden-secret'));assert.equal(f.state.posts,2);
  }finally{await f.close();}
});
test('image API deduplicates requests, fixes the actual size in input, persists candidates and keeps private receipts off API',async()=>{
  const f=await fixture(),app=createApp(f.store,undefined,f.media.root,f.providers);try {
    const preview=await f.service.preview(f.p.id,f.n.id),body={nodeId:f.n.id,requestKey:randomUUID(),revision:preview.revision,inputFingerprint:preview.inputFingerprint};
    const [a,b]=await Promise.all([f.service.submit(f.p.id,body),f.service.submit(f.p.id,body)]);assert.equal(a.id,b.id);
    assert.equal(a.inputSnapshot.mode,'real');assert.equal(a.inputSnapshot.params.size,'1024x1024');
    await f.worker.tick();let project=f.store.get(f.p.id);(project.document.nodes[0] as GenerationNode).data.prompt='已编辑新的提示词';f.store.save(project.id,project.revision,project.document,project.name);
    assert.equal((await f.finish(a)).status,'succeeded');assert.equal(f.state.posts,1);assert.equal(f.store.assets(f.p.id).length,2);
    assert.equal(JSON.parse(f.received[0].body).prompt,a.inputSnapshot.prompt);
    const assets=f.store.assets(f.p.id);assert.ok(assets.every(a=>a.source==='generated'));assert.ok(await f.media.verify(assets[0]));
    const publicData=(await app.inject({url:`/api/projects/${f.p.id}/tasks`})).body;
    assert.ok(!publicData.includes(KEY)&&!publicData.includes('b64_json')&&!publicData.includes('private-token'));
    assert.ok(existsSync(path.join(f.dir,'provider-results',a.id,'0.bin')));
  }finally{await app.close();await f.close();}
});
test('reference images are sent as local data URLs with JSON edits, with no local server URLs or credentials in snapshots',async()=>{
  const f=await fixture();try {
    const asset=await f.inputImage(),task=await f.submit();assert.equal((await f.finish(task)).status,'succeeded');
    const request=f.received.find(r=>r.url==='/v1/images/edits')!,body=JSON.parse(request.body);
    assert.match(body.images[0].image_url,/^data:image\/png;base64,/);assert.deepEqual(task.inputSnapshot.imageAssetIds,[asset.id]);
    assert.ok(!JSON.stringify(task.inputSnapshot).includes(KEY));assert.equal(request.authorization,`Bearer ${KEY}`);
  }finally{await f.close();}
});
test('multipart image compatibility uses repeated image[] files and does not fallback to a second paid POST',async()=>{
  const f=await fixture();try {
    f.configs[1].imageEditFormat='multipart';await f.inputImage();const task=await f.submit();assert.equal((await f.finish(task)).status,'succeeded');
    assert.match(f.received[0].body,/name="image\[\]"; filename="reference-0.png"/);assert.equal(f.state.posts,1);
  }finally{await f.close();}
});
test('image capability checks reject reference overflow, unsupported proportions, excessive candidates and stale service summaries',async()=>{
  const f=await fixture();try {
    await f.inputImage();const cap=f.configs[1].cap;cap.maxReferences=0;await assert.rejects(()=>f.submit(),/参考图片/);cap.maxReferences=2;
    const p=f.store.get(f.p.id);(p.document.nodes[0] as GenerationNode).data.ratio='16:9';f.store.save(p.id,p.revision,p.document,p.name);await assert.rejects(()=>f.submit(),/比例/);
    const next=f.store.get(p.id);(next.document.nodes[0] as GenerationNode).data.ratio='1:1';f.store.save(p.id,next.revision,next.document,next.name);
    cap.maxCount=1;await assert.rejects(()=>f.submit(),/候选/);cap.maxCount=2;
    const preview=await f.service.preview(p.id,f.n.id);cap.serviceId='new-service-profile';
    await assert.rejects(()=>f.service.submit(p.id,{nodeId:f.n.id,requestKey:randomUUID(),revision:preview.revision,inputFingerprint:preview.inputFingerprint}),/变化/);assert.equal(f.state.posts,0);
  }finally{await f.close();}
});
test('submit response loss remains unknown and never automatically repeats a relay request',async()=>{
  const f=await fixture();try {
    f.state.mode='disconnect';const task=await f.submit();assert.equal((await f.finish(task)).status,'unknown');
    for(let i=0;i<5;i++)await f.worker.tick();assert.equal(f.state.posts,1);assert.throws(()=>f.service.requery(task.id),/未找到/);
  }finally{await f.close();}
});
test('HTTP rejection and invalid candidate counts fail clearly without echoing relay error credentials',async()=>{
  const f=await fixture();try {
    f.state.mode='secret-error';const task=await f.submit();assert.equal((await f.finish(task)).status,'failed');assert.match(f.service.tasks.get(task.id).error!,/401/);assert.ok(!f.service.tasks.get(task.id).error!.includes(KEY));
    f.state.mode='wrong-count';const invalid=await f.submit();assert.equal((await f.finish(invalid)).status,'failed');assert.equal(f.state.posts,2);assert.equal(f.store.assets(f.p.id).length,0);
  }finally{await f.close();}
});
test('synchronous receipts survive API/worker restart, and a saved response is recovered explicitly after interrupted state publication',async()=>{
  const f=await fixture();try {
    const task=await f.submit();await f.worker.tick();const running=f.service.tasks.get(task.id);
    f.service.tasks.update(running,{providerTaskId:null,status:'unknown',error:'中断'});f.service.requery(task.id);
    const store2=new ProjectStore(f.file),media2=new MediaStore(f.media.root,store2),registry2=new ProviderRegistry(store2,media2,f.configs,{allowLoopbackForTests:true});
    try{assert.equal((await f.finish(task,new TaskWorker(new TaskService(store2,media2,registry2).tasks,registry2,media2,0))).status,'succeeded');assert.equal(f.state.posts,1);assert.equal(f.store.assets(f.p.id).length,2);}finally{store2.close();}
  }finally{await f.close();}
});
test('partial URL persistence only retries unsaved outputs and never repeats generation; auth is not forwarded to CDN',async()=>{
  const f=await fixture();try {
    f.state.mode='partial-url';const task=await f.submit();assert.equal((await f.finish(task)).status,'failed');assert.equal(f.store.assets(f.p.id).length,1);assert.equal(f.state.posts,1);
    const firstDownloads=f.received.filter(r=>r.url.startsWith('/media/0')).length;f.state.mode='url';f.service.requery(task.id);
    assert.equal((await f.finish(task)).status,'succeeded');assert.equal(f.state.posts,1);assert.equal(f.received.filter(r=>r.url.startsWith('/media/0')).length,firstDownloads);
    assert.ok(f.received.filter(r=>r.url.startsWith('/media/')).every(r=>r.authorization===undefined));
    assert.ok(!f.service.tasks.get(task.id).error);assert.equal(f.store.assets(f.p.id).length,2);
  }finally{await f.close();}
});
test('video JSON task template fixes the first frame, maps nested fields, resumes polling and saves playable MP4 locally',async()=>{
  const f=await fixture('videoGenerate');try {
    await f.inputImage();const task=await f.submit();await f.worker.tick();assert.equal(f.service.tasks.get(task.id).status,'running');
    const store2=new ProjectStore(f.file),media2=new MediaStore(f.media.root,store2),registry2=new ProviderRegistry(store2,media2,f.configs,{allowLoopbackForTests:true});
    try{assert.equal((await f.finish(task,new TaskWorker(new TaskService(store2,media2,registry2).tasks,registry2,media2,0))).status,'succeeded');}finally{store2.close();}
    const body=JSON.parse(f.received[0].body);assert.match(body.image,/^data:image\/png;base64,/);assert.equal(body.duration,5);assert.equal(body.aspect_ratio,'16:9');assert.equal(f.state.posts,1);
    const generated=f.store.assets(f.p.id).find(a=>a.source==='generated')!;assert.equal(generated.mediaType,'video');assert.ok(await f.media.verify(generated));assert.equal(f.service.tasks.generations(f.p.id).length,1);
  }finally{await f.close();}
});
test('unmapped video state enters unknown after bounded queries and retains remote ID without reposting',async()=>{
  const f=await fixture('videoGenerate');try {
    await f.inputImage();f.state.mode='unmapped';const task=await f.submit();assert.equal((await f.finish(task)).status,'unknown');assert.equal(f.state.posts,1);assert.equal(f.state.queries,3);
    f.state.mode='base64';f.service.requery(task.id);assert.equal((await f.finish(task)).status,'succeeded');assert.equal(f.state.posts,1);
  }finally{await f.close();}
});
test('download guard denies private/reserved IPs and localhost DNS, unsupported protocols, unlisted redirect hosts and oversized bodies',async()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','172.16.1.1','192.168.1.1','169.254.1.1','100.64.1.1','0.0.0.0','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001::1','2001:db8::1'])assert.equal(isPublicAddress(ip),false,ip);
  assert.equal(isPublicAddress('8.8.8.8'),true);assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
  await assert.rejects(()=>validateRemote('https://127.0.0.1/file',{hosts:['127.0.0.1']}),/本机/);
  await assert.rejects(()=>validateRemote('https://localhost/file',{hosts:['localhost']}),/本机/);
  await assert.rejects(()=>validateRemote('file:///C:/secret',{hosts:[]}),/协议/);
  await assert.rejects(()=>validateRemote('https://user:pass@cdn.example/a',{hosts:['cdn.example']}),/协议/);
  const f=await fixture();try {
    await assert.rejects(()=>downloadRemote(f.origin+'/redirect',{hosts:['127.0.0.1'],allowLoopbackForTests:true},1000,1000),/允许列表/);
    await assert.rejects(()=>remoteRequest(f.origin+'/large',{hosts:['127.0.0.1'],allowLoopbackForTests:true},{limit:10,timeoutMs:1000}),/大小/);
  }finally{await f.close();}
});
test('M3 schema migrates to M4 without changing old mock fingerprints, revisions or generated history',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'m4-migrate-')),file=path.join(dir,'studio.sqlite');
  try{
    const initial=new ProjectStore(file),p=initial.create('M3 保留项目');const old=node();delete old.data.mode;old.data.model='mock-image-v1';old.data.ratio='16:9';p.document.nodes=[old];
    // Explicit M3 snapshot fixture: absence of mode in a node must preserve the historical mock JSON shape.
    const legacyInput={mode:'mock' as const,provider:'mock' as const,kind:'image' as const,model:'mock-image-v1',prompt:old.data.prompt,imageAssetIds:[],params:{ratio:'16:9',count:2},scenario:'success' as const};
    const legacyFingerprint=await fingerprint(legacyInput),tasks=new TaskStore(initial);
    const task=tasks.create(p.id,old.id,randomUUID(),legacyInput,legacyFingerprint,null);
    const owned=tasks.update(task,{status:'persisting',leaseOwner:'migration-fixture',leaseUntil:Date.now()+60000});
    const media=new MediaStore(path.join(dir,'media'),initial),png=await sharp({create:{width:32,height:32,channels:3,background:'#315b68'}}).png().toBuffer();
    const asset=await media.upload(p.id,'mock-legacy.png','image/png',png,{taskId:task.id,index:0});
    tasks.complete(owned,[asset.id],null,'migration-fixture');
    const historicalTask=tasks.get(task.id),historicalGeneration=tasks.generations(p.id)[0];
    old.data.selectedGenerationId=historicalGeneration.id;old.data.selectedAssetId=asset.id;
    initial.save(p.id,0,p.document,p.name);initial.close();
    const db=new DatabaseSync(file);const doc={...p.document,schemaVersion:3};db.prepare('UPDATE projects SET document=?').run(JSON.stringify(doc));db.exec('DELETE FROM migrations WHERE version=4');db.close();
    const upgraded=new ProjectStore(file);try{
      const saved=upgraded.get(p.id),restored=new TaskStore(upgraded),input=resolveInput(saved.document,old.id,[]);
      assert.equal(saved.document.schemaVersion,4);assert.equal(saved.revision,1);assert.equal(saved.name,p.name);
      assert.deepEqual(input,legacyInput);assert.equal(await fingerprint(input),legacyFingerprint);
      assert.deepEqual(restored.get(task.id),historicalTask);assert.deepEqual(restored.generations(p.id),[historicalGeneration]);
      assert.equal((saved.document.nodes[0] as GenerationNode).data.selectedAssetId,asset.id);
      assert.ok(await new MediaStore(path.join(dir,'media'),upgraded).verify(upgraded.asset(asset.id)));
    }finally{upgraded.close();}
  }finally{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));rmSync(dir,{recursive:true,force:true});}
});
