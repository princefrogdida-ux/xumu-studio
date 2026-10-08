// Build identical, local measurement overlays in disposable copies. Production source and baseline hashes stay untouched.
import { mkdir, readdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
const root = process.cwd();
const overlay = `import {useEffect,useState} from 'react';
let renders={},resolutions=0,frames=[],longTasks=[],panels=[],pendingPanel=null,started=0,active=false,last=0;
export function recordRender(name){if(active)renders[name]=(renders[name]||0)+1;}
export function measuredResolve(fn){if(active)resolutions++;return fn();}
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]:0;
export function Measurements(){const[value,setValue]=useState('');
useEffect(()=>{let live=true,frame;const tick=time=>{if(active&&last)frames.push(time-last);last=time;if(live)frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);
const observer=new PerformanceObserver(list=>{if(active)for(const e of list.getEntries())longTasks.push(e.duration);});try{observer.observe({type:'longtask',buffered:false});}catch{}
const click=e=>{const button=e.target.closest('button');if(!active||!button)return;const text=button.textContent.trim();const title=['分镜清单','任务与历史','素材库','角色','场景','导入 / 导出'].find(t=>text.startsWith(t));if(title)pendingPanel={title:title==='导入 / 导出'?'导入与导出':title,start:performance.now()};};
const mutations=new MutationObserver(()=>{if(!pendingPanel)return;const heading=[...document.querySelectorAll('main h1,[role="dialog"] h2')].find(el=>el.textContent===pendingPanel.title);if(heading){const p=pendingPanel;pendingPanel=null;requestAnimationFrame(()=>panels.push({title:p.title,ms:performance.now()-p.start}));}});mutations.observe(document.getElementById('root'),{subtree:true,childList:true});document.addEventListener('click',click,true);
return()=>{live=false;cancelAnimationFrame(frame);observer.disconnect();mutations.disconnect();document.removeEventListener('click',click,true);};},[]);
const report=()=>{const nav=performance.getEntriesByType('navigation')[0];const resources=performance.getEntriesByType('resource');const js=resources.filter(e=>e.name.includes('/assets/')&&e.name.endsWith('.js'));
const history=resources.filter(e=>/\\/(task-activity|tasks)(\\?|$)/.test(e.name));
setValue(JSON.stringify({viewport:[innerWidth,innerHeight],browser:navigator.userAgent,elapsedMs:performance.now()-started,renders,resolutions,panels,frames:{count:frames.length,medianMs:percentile(frames,.5),p95Ms:percentile(frames,.95),maxMs:Math.max(0,...frames)},longTasks:{count:longTasks.length,maxMs:Math.max(0,...longTasks)},navigation:nav?{domContentLoadedMs:nav.domContentLoadedEventEnd,loadMs:nav.loadEventEnd}:null,js:{count:js.length,encodedBytes:js.reduce((s,e)=>s+e.encodedBodySize,0),transferBytes:js.reduce((s,e)=>s+e.transferSize,0)},polls:history.map(e=>({relativeMs:e.startTime,ms:e.duration,bytes:e.encodedBodySize}))}));};
return <div style={{position:'fixed',bottom:4,right:4,zIndex:99999,background:'#fff',color:'#000',padding:4,maxWidth:350,fontSize:10}}><button onClick={()=>{renders={};resolutions=0;frames=[];longTasks=[];panels=[];pendingPanel=null;started=performance.now();last=0;active=true;setValue('measuring');}}>开始测量</button><button onClick={()=>{active=false;report();}}>记录测量</button><output aria-label="本地性能测量">{value}</output></div>;}
`;
async function copy(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || ['node_modules', 'dist'].includes(entry.name) || /\.local\.json$/.test(entry.name)) continue;
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copy(from, to); else if (entry.isFile()) await copyFile(from, to);
  }
}
for (const kind of ['baseline', 'optimized']) {
  const source = kind === 'baseline' ? path.join(root, 'output/optimization/baseline-code') : root;
  const target = path.join(root, `output/optimization/browser-${kind}`);
  for (const directory of ['apps', 'packages']) await copy(path.join(source, directory), path.join(target, directory));
  await copyFile(path.join(root, 'package.json'), path.join(target, 'package.json'));
  await writeFile(path.join(target, 'apps/web/src/measurements.jsx'), overlay);
  for (const [file, marker, name, relative] of [
    ['App.tsx', 'function Workspace() {', 'Workspace', './measurements.jsx'],
    ['features/canvas/Canvas.tsx', '  const doc = useEditor', 'Canvas', '../../measurements.jsx'],
    ['features/canvas/DomainNode.tsx', '  const doc = useEditor', 'DomainNode', '../../measurements.jsx'],
  ]) {
    const destination = path.join(target, 'apps/web/src', file);
    let code = await readFile(destination, 'utf8');
    code = `import {recordRender,measuredResolve} from '${relative}';\n` + code;
    code = name === 'Workspace' ? code.replace(marker, marker + `\n  recordRender('${name}');`) : code.replace(marker, `  recordRender('${name}');\n` + marker);
    if (name === 'DomainNode') code = code.replace('resolveInput(doc,id,assets,capabilities)', 'measuredResolve(()=>resolveInput(doc,id,assets,capabilities))');
    await writeFile(destination, code);
  }
  const main = path.join(target, 'apps/web/src/main.tsx');
  await writeFile(main, (await readFile(main, 'utf8')).replace("import { App }", "import {Measurements} from './measurements.jsx';\nimport { App }").replace('render(<App />)', 'render(<><App /><Measurements /></>)'));
  const child = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'apps/web/vite.config.ts'], { cwd: target, windowsHide: true, stdio: 'inherit' });
  const code = await new Promise(resolve => child.once('exit', resolve));
  if (code) throw new Error(`${kind} measurement build failed`);
  console.log(`${kind}: ${target}`);
}
