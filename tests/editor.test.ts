import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { useEditor } from '../apps/web/src/features/canvas/editor-store.ts';
import { storyDocument, nodeText } from '../packages/shared/src/index.ts';

test('one drag or field edit creates one undo step; view changes do not enter history', () => {
  const doc = storyDocument(randomUUID);
  useEditor.getState().load({ id: 'test', name: 'test', document: doc, revision: 0, createdAt: '', updatedAt: '' });
  const id = doc.nodes[0].id;
  useEditor.getState().begin();
  useEditor.getState().editNode(id, { content: 'first' });
  useEditor.getState().editNode(id, { content: 'second' });
  useEditor.getState().end();
  assert.equal(useEditor.getState().past.length, 1);
  useEditor.getState().update(d => ({ ...d, viewport: { x: 4, y: 5, zoom: 0.5 } }), false);
  useEditor.getState().undo();
  assert.equal(nodeText(useEditor.getState().doc, useEditor.getState().doc.nodes[0]), nodeText(doc, doc.nodes[0]));
  assert.equal(useEditor.getState().doc.viewport.zoom, 0.5);
  useEditor.getState().redo();
  assert.equal(nodeText(useEditor.getState().doc, useEditor.getState().doc.nodes[0]), 'second');
});

test('delete removes related edges and undo restores both; copy remaps only internal edges', () => {
  const s = useEditor.getState(), before = structuredClone(s.doc);
  s.select([before.nodes[0].id]); s.remove();
  assert.equal(useEditor.getState().doc.edges.length, 0);
  useEditor.getState().undo();
  assert.deepEqual(useEditor.getState().doc.nodes, before.nodes);
  useEditor.getState().select([before.nodes[0].id, before.nodes[3].id]);
  useEditor.getState().copy(); useEditor.getState().paste();
  assert.equal(useEditor.getState().doc.nodes.length, before.nodes.length + 2);
  assert.equal(useEditor.getState().doc.edges.length, before.edges.length + 1);
});
