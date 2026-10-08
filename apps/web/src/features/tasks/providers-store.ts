import { create } from 'zustand';
import { mockModels, type ProviderCapability } from '../../../../../packages/shared/src/generation.ts';
import { request } from '../../lib/api.ts';

export const useProviders=create<{capabilities:ProviderCapability[];error:string;load:()=>Promise<void>}>((set)=>({
  capabilities:mockModels,error:'',
  load:async()=>{try{const result=await request<{providers:ProviderCapability[]}>('/api/providers/capabilities');
    if(!Array.isArray(result.providers))throw new Error('API 仍为旧版本，请重启 API 和 worker 后刷新');
    set({capabilities:result.providers,error:''});
  }catch(error){set({capabilities:mockModels,error:(error as Error).message});}},
}));
