import { create } from 'zustand';
import type { Asset } from '../../../../../packages/shared/src/index.ts';
import { api } from '../../lib/api.ts';

export const useAssets = create<{ projectId: string; assets: Asset[]; error: string; load: (id: string) => Promise<void>; add: (id: string, asset: Asset) => void; fail: (id: string) => void }>((set, get) => ({
  projectId: '', assets: [], error: '',
  load: async id => {
    if (get().projectId !== id) set({ projectId: id, assets: [], error: '' });
    try { const assets = await api.assets(id); if (get().projectId === id) set({ assets, error: '' }); }
    catch (error) { if (get().projectId === id) set({ error: (error as Error).message }); }
  },
  add: (id, asset) => { if (get().projectId === id) set(s => ({ assets: [asset, ...s.assets.filter(a => a.id !== asset.id)] })); },
  fail: id => set(s => ({ assets: s.assets.map(a => a.id === id ? { ...a, status: 'damaged' } : a) })),
}));
