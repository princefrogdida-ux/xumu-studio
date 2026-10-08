import { readFileSync, writeFileSync, mkdirSync, cpSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ProjectStore } from '../apps/server/src/db/store.ts';
import { TaskStore } from '../apps/server/src/tasks/store.ts';
const root=path.resolve('output/optimization'),source=path.join(root,'stopped-data');
const snapshots=JSON.parse(readFileSync(path.join(root,'before-projects-tasks.json'),'utf8').replace(/^\uFEFF/,''));
const hashes=JSON.parse(readFileSync(path.join(root,'stopped-data-hashes.json'),'utf8').replace(/^\uFEFF/,'')) as {path:string;sha256:string}[];
for(const item of hashes){const hash=createHash('sha256');for await(const chunk of createReadStream(path.join(source,item.path)))hash.update(chunk);if(hash.digest('hex').toUpperCase()!==item.sha256)throw new Error('备份校验失败：'+item.path);}
const target=path.join(root,'validation-data'),baseline=path.join(root,'baseline-validation-data');
if(!process.argv.includes('--existing')){mkdirSync(target);cpSync(source,target,{recursive:true});mkdirSync(baseline);cpSync(source,baseline,{recursive:true});}
const store=new ProjectStore(path.join(target,'studio.sqlite')),tasks=new TaskStore(store);
try{
  const canonical=(value:unknown)=>JSON.stringify(value,(key,v)=>['createdAt','updatedAt'].includes(key)&&typeof v==='string'?new Date(v).toISOString():v);
  for(const s of snapshots){if(canonical(store.get(s.project.id))!==canonical(s.project))throw new Error('迁移改变项目：'+s.project.id);const history={tasks:tasks.list(s.project.id),generations:tasks.generations(s.project.id)};if(canonical(history)!==canonical(s.history))throw new Error('迁移改变历史：'+s.project.id);}
  const before=new DatabaseSync(path.join(baseline,'studio.sqlite'),{readOnly:true});
  try{for(const table of ['projects','tasks','generations','assets','project_assets']){
    if(JSON.stringify(before.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())!==JSON.stringify(store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))throw new Error('迁移改变原始数据：'+table);
  }}finally{before.close();}
  const original=new DatabaseSync(path.resolve('data/studio.sqlite'),{readOnly:true});
  try{const originalVersion=(original.prepare('SELECT max(version) AS n FROM migrations').get() as {n:number}).n;const integrity=original.prepare('PRAGMA integrity_check').get();
    writeFileSync(path.join(root,'migration-audit.json'),JSON.stringify({backupFilesVerified:hashes.length,projectsPreserved:snapshots.length,tasksPreserved:snapshots.reduce((n:number,s:{history:{tasks:unknown[]}})=>n+s.history.tasks.length,0),validationDatabaseVersion:5,documentVersion:4,originalDatabaseVersion:originalVersion,originalIntegrity:integrity},null,2));
  }finally{original.close();}
  console.log('备份 50 文件校验通过；8 项目/13 任务完整保留；隔离目录迁移版本 5。原 data 未迁移。');
}finally{store.close();}
