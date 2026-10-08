import {spawn} from 'node:child_process';
const children=[];
for(const baseline of [true,false]) children.push(spawn(process.execPath,['--import','tsx','scripts/optimization-measure-server.ts',...(baseline?['--baseline']:[])],{windowsHide:true,env:{...process.env,PORT:baseline?'4332':'4331',STUDIO_REAL_CALLS_ENABLED:'false'},stdio:['ignore','inherit','inherit','ipc']}));
let stopping=false;
function stop(){if(stopping)return;stopping=true;for(const c of children)if(c.connected)c.send('shutdown');}
for(const child of children)child.on('exit',()=>{if(stopping&&children.every(c=>c.exitCode!==null)){process.stdin.pause();console.log('测量服务正常停止');}});
process.stdin.setEncoding('utf8');process.stdin.on('data',t=>{if(t.trim()==='stop')stop();});process.on('SIGINT',stop);
