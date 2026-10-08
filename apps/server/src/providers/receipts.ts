import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const ReceiptSchema=z.object({serviceId:z.string(),remoteId:z.string().optional(),rawDraft:z.unknown().optional(),
  outputs:z.array(z.object({url:z.string().optional(),file:z.string().regex(/^\d+\.bin$/).optional(),mime:z.string()}).strict()).max(4).optional()}).strict();
export type Receipt=z.infer<typeof ReceiptSchema>;
/** Private receipts contain transient remote URLs, never served by the public API or project exports. */
export class ReceiptStore {
  constructor(readonly root:string) {}
  private dir(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('回执标识无效');return path.join(this.root,id);}
  exists(id:string){return existsSync(path.join(this.dir(id),'receipt.json'));}
  get(id:string):Receipt{return ReceiptSchema.parse(JSON.parse(readFileSync(path.join(this.dir(id),'receipt.json'),'utf8')));}
  async save(id:string,receipt:Receipt){await mkdir(this.dir(id),{recursive:true});await this.atomic(path.join(this.dir(id),'receipt.json'),Buffer.from(JSON.stringify(ReceiptSchema.parse(receipt))));}
  async writeOutput(id:string,index:number,bytes:Buffer){await mkdir(this.dir(id),{recursive:true});await this.atomic(path.join(this.dir(id),`${index}.bin`),bytes);return `${index}.bin`;}
  readOutput(id:string,file:string){if(!/^\d+\.bin$/.test(file))throw new Error('回执文件名无效');return readFile(path.join(this.dir(id),file));}
  private async atomic(filename:string,bytes:Buffer){const temp=`${filename}.${randomUUID()}.part`;await writeFile(temp,bytes,{flag:'wx'});await rename(temp,filename);}
}
