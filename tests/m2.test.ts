import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { createApp } from '../apps/server/src/api/app.ts';
import { ProjectStore } from '../apps/server/src/db/store.ts';
import { byteRange } from '../apps/server/src/storage/media.ts';
import { DocumentSchema, emptyDocument, newShot, connectionError, type Asset, type CanvasNode } from '../packages/shared/src/index.ts';
import { useEditor } from '../apps/web/src/features/canvas/editor-store.ts';

test('M1 database upgrade preserves names, revisions, text and viewport; corrupt migration rolls back', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-migrate-'));
  try {
    for (const valid of [true, false]) {
      const file = path.join(dir, `${valid}.sqlite`), db = new DatabaseSync(file);
      db.exec('CREATE TABLE migrations(version INTEGER PRIMARY KEY, applied_at TEXT); INSERT INTO migrations VALUES(1, "date");'.replace('"date"', "'date'"));
      db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT, revision INTEGER, document TEXT, created_at TEXT, updated_at TEXT)');
      const doc = { schemaVersion: valid ? 1 : 99, nodes: [], edges: [], viewport: { x: 42, y: -7, zoom: .6 } };
      db.prepare('INSERT INTO projects VALUES(?, ?, 4, ?, ?, ?)').run('legacy', '旧项目', JSON.stringify(doc), 'before', 'before'); db.close();
      if (valid) {
        const store = new ProjectStore(file); const p = store.get('legacy');
        try { assert.equal(p.document.schemaVersion, 4); assert.deepEqual(p.document.viewport, doc.viewport); assert.equal(p.revision,4); assert.equal(p.name,'旧项目'); } finally { store.close(); }
      } else {
        assert.throws(() => new ProjectStore(file));
        const verify = new DatabaseSync(file);
        assert.equal((verify.prepare('SELECT MAX(version) AS n FROM migrations').get() as {n:number}).n,1);
        assert.equal((verify.prepare('SELECT document FROM projects').get() as {document:string}).document,JSON.stringify(doc)); verify.close();
      }
    }
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('media upload validates bytes and ownership, persists originals and thumbnails, supports ranges and reports corruption', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-media-')), file = path.join(dir,'db.sqlite'), root = path.join(dir,'media');
  let store = new ProjectStore(file), app = createApp(store, undefined, root);
  try {
    const p = store.create('镜头项目'), other = store.create('隔离项目');
    const png = await sharp({create:{width:32,height:24,channels:3,background:'#a89ac1'}}).png().toBuffer();
    const upload = (name: string, bytes: Buffer, mime = 'image/png') => app.inject({method:'POST',url:`/api/projects/${p.id}/assets?name=${encodeURIComponent(name)}`,headers:{'content-type':mime},payload:bytes});
    const good = await upload('角色.png',png); assert.equal(good.statusCode,201); const asset = good.json<Asset>();
    assert.equal(asset.width,32); assert.equal('filename' in asset,false);
    assert.equal((await upload('伪装.png',Buffer.from('<html>bad</html>'))).statusCode,400);
    assert.equal((await upload('../角色.png',png)).statusCode,400);
    assert.equal((await upload('错类型.jpg',png,'image/jpeg')).statusCode,400);
    assert.equal((await upload('动画.svg',Buffer.from('<svg/>'),'application/octet-stream')).statusCode,400);
    assert.equal((await app.inject({url:`/api/assets/${asset.id}/thumbnail`})).headers['content-type'],'image/webp');
    const full = await app.inject({url:`/api/assets/${asset.id}/file`}); assert.deepEqual(full.rawPayload,png);
    const part = await app.inject({url:`/api/assets/${asset.id}/file`,headers:{range:'bytes=3-8'}});
    assert.equal(part.statusCode,206); assert.deepEqual(part.rawPayload,png.subarray(3,9));
    assert.equal((await app.inject({url:`/api/assets/${asset.id}/file`,headers:{range:'bytes=999999-'}})).statusCode,416);
    const doc = emptyDocument(); doc.nodes.push({id:'media',type:'media',position:{x:0,y:0},width:300,height:280,data:{assetId:asset.id,mediaType:'image'}});
    assert.throws(() => store.save(other.id,0,doc,other.name),/不属于/);
    const refId = randomUUID(); doc.references.push({id:refId,kind:'character',name:'林夏',description:'',assetIds:[asset.id],selectedAssetId:asset.id});
    doc.shots = Array.from({length:3},(_,i) => ({...newShot(randomUUID(),i),characterIds:[refId]}));
    const saved = store.save(p.id,0,doc,p.name), copy = store.duplicate(p.id);
    assert.equal(copy.document.references[0].selectedAssetId,asset.id); assert.notEqual(copy.document.references[0].id,refId);
    assert.ok(copy.document.shots.every(s => s.characterIds[0] === copy.document.references[0].id));
    assert.equal(store.assets(copy.id).length,1);
    await app.close(); store.close(); store = new ProjectStore(file); app = createApp(store,undefined,root);
    assert.deepEqual(store.get(p.id).document,saved.document);
    assert.deepEqual((await app.inject({url:`/api/assets/${asset.id}/file`})).rawPayload,png);
    const filename = path.join(root,store.asset(asset.id).filename);
    const damaged = Buffer.from(png); damaged[20] ^= 1; writeFileSync(filename,damaged);
    assert.equal((await app.inject({url:`/api/assets/${asset.id}/file`})).statusCode,410);
    unlinkSync(filename);
    assert.equal((await app.inject({url:`/api/projects/${p.id}/assets`})).json<Asset[]>()[0].status,'missing');
    assert.equal((await app.inject({url:`/api/assets/${asset.id}/file`})).statusCode,410);
  } finally { await app.close(); store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('typed ports distinguish shot prompts, cap image inputs, and reject invalid record references', () => {
  const doc = emptyDocument(), shot = newShot('shot',0); doc.shots.push(shot);
  const shotNode: CanvasNode = {id:'shot-node',type:'shot',position:{x:0,y:0},width:300,height:250,data:{shotId:shot.id}};
  doc.nodes.push(shotNode,...Array.from({length:9},(_,i):CanvasNode => ({id:`media${i}`,type:'media',position:{x:0,y:0},width:300,height:250,data:{assetId:randomUUID(),mediaType:'image'}})));
  for (let i=0;i<8;i++) {const edge = {id:`edge${i}`,source:`media${i}`,target:'shot-node',sourceHandle:'image-out' as const,targetHandle:'image-in' as const,inputOrder:i}; assert.equal(connectionError(doc.nodes,doc.edges,edge),null); doc.edges.push(edge);}
  assert.match(connectionError(doc.nodes,doc.edges,{source:'media8',target:'shot-node',sourceHandle:'image-out',targetHandle:'image-in'})!,/最多/);
  assert.match(connectionError(doc.nodes,[],{source:'media0',target:'shot-node',sourceHandle:'image-out',targetHandle:'text-in'})!,/类型/);
  assert.equal(DocumentSchema.safeParse(doc).success,true);
  doc.shots[0].characterIds = ['missing']; assert.equal(DocumentSchema.safeParse(doc).success,false);
  assert.deepEqual(byteRange('bytes=-3',10),{start:7,end:9}); assert.equal(byteRange('bytes=2-1',10),null); assert.equal(byteRange('bytes=0-1,4-5',10),null);
});

test('shared references and shots survive undo, independent ordering, view deletion and re-placement', () => {
  useEditor.getState().load({id:'p',name:'p',revision:0,createdAt:'',updatedAt:'',document:emptyDocument()});
  const s = useEditor.getState(); s.addReference('character',{x:0,y:0}); const refId = useEditor.getState().doc.references[0].id;
  for (let i=0;i<3;i++) s.addShot({x:i*400,y:200});
  const shots = useEditor.getState().doc.shots;
  for (const shot of shots) s.editShot(shot.id,{characterIds:[refId]});
  const positions = useEditor.getState().doc.nodes.map(n => n.position);
  s.moveShot(shots[2].id,-1); assert.equal(useEditor.getState().doc.shots.find(x => x.id === shots[2].id)?.order,1);
  assert.deepEqual(useEditor.getState().doc.nodes.map(n => n.position),positions);
  s.undo(); assert.equal(useEditor.getState().doc.shots.find(x => x.id === shots[2].id)?.order,2);
  s.editReference(refId,{name:'复用角色'}); assert.ok(useEditor.getState().doc.shots.every(x => x.characterIds[0] === refId));
  const node = useEditor.getState().doc.nodes.find(n => n.type === 'shot')!;
  s.select([node.id]); s.remove(); assert.equal(useEditor.getState().doc.shots.length,3);
  s.placeRecord('shot',shots[0].id,{x:10,y:10});
  s.deleteRecord('reference',refId); assert.ok(useEditor.getState().doc.shots.every(x => !x.characterIds.length));
  s.undo(); assert.equal(useEditor.getState().doc.references[0].name,'复用角色'); assert.ok(useEditor.getState().doc.shots.every(x => x.characterIds[0] === refId));
  assert.equal(DocumentSchema.safeParse(useEditor.getState().doc).success,true);
});
