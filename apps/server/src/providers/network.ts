import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

export class NetworkError extends Error {}
export interface NetworkPolicy { hosts:string[]; allowLoopbackForTests?:boolean }
export function isPublicAddress(ip:string):boolean {
  if(isIP(ip)===4) {
    const [a,b]=ip.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&[0,168].includes(b)||a===100&&b>=64&&b<=127||a===198&&[18,19,51].includes(b)||a===203&&b===0);
  }
  if(isIP(ip)===6) {
    // Only global unicast; IPv4-mapped, loopback, unique-local and link-local addresses are excluded.
    const [a,b]=ip.split(':'),first=parseInt(a,16),second=parseInt(b||'0',16);
    return first>=0x2000&&first<0x3ffe&&!(first===0x2001&&(second<=0x1ff||second===0xdb8))&&first!==0x2002;
  }
  return false;
}
export async function validateRemote(urlText:string,policy:NetworkPolicy) {
  let url:URL;try{url=new URL(urlText);}catch{throw new NetworkError('服务返回了无效下载地址');}
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  const localTest=policy.allowLoopbackForTests&&['127.0.0.1','::1','localhost'].includes(host);
  if((url.protocol!=='https:'&&!(localTest&&url.protocol==='http:'))||url.username||url.password||url.hash||!policy.hosts.includes(host))throw new NetworkError('远端地址协议或主机不在服务端允许列表中');
  let addresses:{address:string;family:number}[];
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    addresses=isIP(host)?[{address:host,family:isIP(host)}]:await Promise.race([lookup(host,{all:true}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new NetworkError('远端域名解析超时')),10000);})]);
  } catch {throw new NetworkError('远端域名无法安全解析');} finally{clearTimeout(timer);}
  if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)&&!(localTest&&['127.0.0.1','::1'].includes(a.address))))throw new NetworkError('拒绝访问本机、内网或保留地址');
  return {url,addresses};
}
/** DNS is resolved and pinned on each request, including every redirect. Authorization is never forwarded by a redirect. */
export async function remoteRequest(urlText:string,policy:NetworkPolicy,options:{method?:string;headers?:Record<string,string>;body?:Buffer;limit:number;timeoutMs:number}) {
  const {url,addresses}=await validateRemote(urlText,policy);
  return new Promise<{status:number;mime:string;location?:string;bytes:Buffer}>((resolve,reject)=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const req=(url.protocol==='https:'?https:http).request(url,{method:options.method??'GET',headers:options.headers,
      lookup:(_host,opts,callback)=>{const o=opts as {all?:boolean};if(o.all)callback(null,addresses as never);else callback(null,addresses[0].address,addresses[0].family);}},res=>{
      const chunks:Buffer[]=[];let size=0;
      if(Number(res.headers['content-length']??0)>options.limit){clearTimeout(timer);reject(new NetworkError('远端响应超过允许大小'));res.destroy();req.destroy();return;}
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>options.limit){clearTimeout(timer);reject(new NetworkError('远端响应超过允许大小'));req.destroy();res.destroy();}else chunks.push(chunk);});
      res.on('end',()=>{clearTimeout(timer);resolve({status:res.statusCode??0,mime:(res.headers['content-type']??'').split(';')[0],location:res.headers.location,bytes:Buffer.concat(chunks)});});
      res.on('error',()=>{clearTimeout(timer);reject(new NetworkError('远端响应中断，状态可能尚未确认'));});
      res.on('aborted',()=>{clearTimeout(timer);reject(new NetworkError('远端响应中断，状态可能尚未确认'));});
    });
    timer=setTimeout(()=>{reject(new NetworkError('远端请求超时，状态可能尚未确认'));req.destroy();},options.timeoutMs);
    req.on('error',(error)=>{clearTimeout(timer);reject(error instanceof NetworkError?error:new NetworkError('远端连接失败，状态可能尚未确认'));});
    req.end(options.body);
  });
}
export async function downloadRemote(url:string,policy:NetworkPolicy,limit:number,timeoutMs:number) {
  for(let redirects=0;redirects<=3;redirects++) {
    const response=await remoteRequest(url,policy,{limit,timeoutMs});
    if([301,302,303,307,308].includes(response.status)&&response.location){url=new URL(response.location,url).href;continue;}
    if(response.status!==200)throw new NetworkError(`素材下载失败（HTTP ${response.status}），仅重试下载`);
    return response;
  }
  throw new NetworkError('素材下载重定向过多');
}
