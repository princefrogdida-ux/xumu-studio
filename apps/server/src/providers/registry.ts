import path from 'node:path';
import { mockCapabilities, mockModels, type InputSnapshot } from '../../../../packages/shared/src/generation.ts';
import { ProjectStore } from '../db/store.ts';
import { MediaStore } from '../storage/media.ts';
import { readRelayConfigs, type RelayConfig } from './config.ts';
import { MockProvider } from './mock.ts';
import { RelayProvider } from './relay.ts';
import { ReceiptStore } from './receipts.ts';
import { DefiniteError, type Provider } from './provider.ts';
import type { NetworkPolicy } from './network.ts';
import { runtimeInfo } from '../../../../packages/shared/src/runtime.ts';

export class ProviderRegistry {
  readonly mock:MockProvider;readonly relays:RelayProvider[];
  constructor(projects:ProjectStore,media:MediaStore,configs:RelayConfig[]=readRelayConfigs(),testPolicy:Pick<NetworkPolicy,'allowLoopbackForTests'>={}) {
    this.mock=new MockProvider(projects);
    const receipts=new ReceiptStore(path.join(media.root,'..','provider-results'));
    this.relays=configs.map(config=>new RelayProvider(config,projects,media,receipts,testPolicy));
  }
  capabilities(){return [...mockModels,...this.relays.map(p=>p.getCapabilities())];}
  publicCapabilities(){return {...mockCapabilities,...runtimeInfo,providers:this.capabilities()};}
  get(input:InputSnapshot):Provider {
    if(input.provider==='mock'&&input.mode==='mock')return this.mock;
    const provider=this.relays.find(p=>p.config.cap.provider===input.provider);
    if(!provider||provider.config.cap.serviceId!==input.serviceId)throw new DefiniteError('服务配置已变化或适配器不可用；请恢复原配置后重新查询');
    return provider;
  }
}
