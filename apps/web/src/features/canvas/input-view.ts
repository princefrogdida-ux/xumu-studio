import { isGenerationNode, type CanvasDocument } from '../../../../../packages/shared/src/index.ts';
const indexes = new WeakMap<CanvasDocument, { nodes: Map<string, CanvasDocument['nodes'][number]>; shots: Map<string, CanvasDocument['shots'][number]>; references: Map<string, CanvasDocument['references'][number]> }>();
function index(doc: CanvasDocument) {
  let value = indexes.get(doc);
  if (!value) { value = { nodes: new Map(doc.nodes.map(n => [n.id, n])), shots: new Map(doc.shots.map(s => [s.id, s])), references: new Map(doc.references.map(r => [r.id, r])) }; indexes.set(doc, value); }
  return value;
}
const views = new Map<string, { key: unknown[]; doc: CanvasDocument }>();
/** Retain a node's business view when unrelated records change. Positions never participate. */
export function nodeInputView(doc: CanvasDocument, id: string) {
  const lookup = index(doc), node = lookup.nodes.get(id), incoming = doc.edges.filter(e => e.target === id);
  const nodes = [...new Set([id, ...incoming.map(e => e.source)])].flatMap(key => { const n = lookup.nodes.get(key); return n ? [n] : []; });
  const shotIds = nodes.flatMap(n => n.type === 'shot' ? [n.data.shotId] : isGenerationNode(n) && n.data.shotId ? [n.data.shotId] : []);
  const shots = [...new Set(shotIds)].flatMap(key => { const s = lookup.shots.get(key); return s ? [s] : []; });
  const refIds = [...nodes.flatMap(n => n.type === 'reference' ? [n.data.referenceId] : []), ...shots.flatMap(s => [...s.characterIds, ...(s.sceneId ? [s.sceneId] : [])])];
  const references = [...new Set(refIds)].flatMap(key => { const r = lookup.references.get(key); return r ? [r] : []; });
  const key: unknown[] = [node?.type, ...nodes.flatMap(n => [n.id, n.type, n.data]), ...incoming, ...shots, ...references];
  const previous = views.get(id);
  if (previous && key.length === previous.key.length && key.every((v, i) => v === previous.key[i])) return previous.doc;
  const view = { ...doc, nodes, edges: incoming, shots, references };
  views.delete(id); views.set(id, { key, doc: view });
  if (views.size > 1000) views.delete(views.keys().next().value!);
  return view;
}
