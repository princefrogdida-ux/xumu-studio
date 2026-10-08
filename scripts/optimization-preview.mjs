import { spawn } from 'node:child_process';
import path from 'node:path';
const children=new Set();let worker,stopping=false;
const env={...process.env,STUDIO_REAL_CALLS_ENABLED:'false',STUDIO_DATA_DIR:path.resolve('output/optimization/validation-data'),PORT:'4321'};
function start(args,variables=env){const child=spawn(process.execPath,args,{cwd:process.cwd(),env:variables,stdio:['ignore','inherit','inherit','ipc'],windowsHide:true});children.add(child);child.on('exit',()=>{children.delete(child);if(stopping&&!children.size){process.stdin.pause();console.log('隔离预览全部停止');}});return child;}
start(['--import','tsx','apps/server/src/index.ts']);
worker=start(['--import','tsx','apps/server/src/worker/index.ts']);
start(['--import','tsx','output/optimization/baseline-preview.ts'],{...env,PORT:'4322',STUDIO_DATA_DIR:path.resolve('output/optimization/baseline-validation-data')});
function stop(){if(stopping)return;stopping=true;for(const child of children)if(child.connected)child.send('shutdown');}
process.stdin.setEncoding('utf8');process.stdin.on('data',text=>{for(const command of text.trim().split(/\r?\n/)){if(command==='stop')stop();else if(command==='stop-worker'&&worker?.connected)worker.send('shutdown');else if(command==='start-worker'&&!children.has(worker))worker=start(['--import','tsx','apps/server/src/worker/index.ts']);}});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);
