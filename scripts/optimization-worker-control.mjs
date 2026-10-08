// Local verification only. Keep the real-call gate closed and use the isolated data copy.
import {spawn} from 'node:child_process';
import path from 'node:path';
const child=spawn(process.execPath,['--import','tsx','apps/server/src/worker/index.ts'],{windowsHide:true,env:{...process.env,STUDIO_REAL_CALLS_ENABLED:'false',STUDIO_DATA_DIR:path.resolve('output/optimization/validation-data')},stdio:['ignore','inherit','inherit','ipc']});
let stopping=false;
function stop(){if(stopping)return;stopping=true;if(child.connected)child.send('shutdown');}
child.on('exit',code=>{console.log('隔离 worker 退出码：'+code);process.exitCode=code??1;process.stdin.pause();});
process.stdin.setEncoding('utf8');process.stdin.on('data',text=>{if(text.trim()==='stop')stop();});process.on('SIGINT',stop);
