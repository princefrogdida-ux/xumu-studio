import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectionError, DocumentSchema, duplicateSelection, storyDocument } from '../packages/shared/src/index.ts';

test('graph rejects missing nodes, incompatible ports, cycles and multiple text inputs', () => {
  const doc = storyDocument(randomUUID), [a, b, c] = doc.nodes;
  const edge = { id: 'edge', source: a.id, target: b.id, sourceHandle: 'text-out' as const, targetHandle: 'text-in' as const };
  assert.equal(connectionError(doc.nodes, [], edge), null);
  assert.match(connectionError(doc.nodes, [edge], { ...edge, source: b.id, target: a.id })!, /循环/);
  assert.match(connectionError(doc.nodes, [edge], { ...edge, source: c.id })!, /一个上游/);
  assert.match(connectionError(doc.nodes, [], { ...edge, source: 'missing' })!, /不存在/);
  assert.match(connectionError(doc.nodes, [], { ...edge, sourceHandle: 'image-out' })!, /类型/);
  assert.match(connectionError(doc.nodes, [], { ...edge, target: a.id })!, /自身/);
});

test('copy selection creates new IDs and only duplicates internal edges', () => {
  const doc = storyDocument(randomUUID);
  const selected = [doc.nodes[0].id, doc.nodes[3].id];
  const copy = duplicateSelection(doc, selected, randomUUID);
  assert.equal(copy.nodes.length, doc.nodes.length + 2);
  assert.equal(copy.edges.length, doc.edges.length + 1);
  assert.equal(new Set(copy.nodes.map(n => n.id)).size, copy.nodes.length);
  assert.equal(copy.nodes[4].position.x, doc.nodes[0].position.x + 48);
  assert.equal(DocumentSchema.safeParse(copy).success, true);
  assert.deepEqual(doc.nodes[0].position, { x: 0, y: 0 });
});

test('schema rejects duplicate IDs, unsupported versions and dangling edges', () => {
  const doc = storyDocument(randomUUID);
  assert.equal(DocumentSchema.safeParse({ ...doc, schemaVersion: 99 }).success, false);
  assert.equal(DocumentSchema.safeParse({ ...doc, nodes: [...doc.nodes, doc.nodes[0]] }).success, false);
  assert.equal(DocumentSchema.safeParse({ ...doc, nodes: doc.nodes.slice(1) }).success, false);
});
