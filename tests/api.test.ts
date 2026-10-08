import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../apps/server/src/api/app.ts';
import { ProjectStore } from '../apps/server/src/db/store.ts';
import type { Project } from '../packages/shared/src/index.ts';

test('project API persists 20 nodes; stale revisions cannot overwrite; duplicate remaps IDs', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-api-'));
  const store = new ProjectStore(':memory:'), app = createApp(store, undefined, path.join(dir, 'media'));
  try {
    const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '测试项目', template: 'story' } });
    assert.equal(created.statusCode, 201);
    const p = created.json<Project>();
    const document = structuredClone(p.document);
    document.nodes = Array.from({ length: 20 }, (_, i) => ({ ...p.document.nodes[0], id: `node-${i}`, position: { x: i * 320, y: 40 } }));
    document.edges = document.nodes.slice(1).map((n, i) => ({ id: `edge-${i}`, source: document.nodes[i].id, target: n.id, sourceHandle: 'text-out', targetHandle: 'text-in' }));
    const request = { method: 'PUT' as const, url: `/api/projects/${p.id}/document`, payload: { revision: 0, name: p.name, document } };
    const [first, second] = await Promise.all([app.inject(request), app.inject(request)]);
    assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 409]);
    const loaded = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}` })).json<Project>();
    assert.equal(loaded.document.nodes.length, 20); assert.equal(loaded.revision, 1);
    const duplicate = (await app.inject({ method: 'POST', url: `/api/projects/${p.id}/duplicate` })).json<Project>();
    assert.equal(duplicate.document.nodes.length, 20);
    assert.ok(duplicate.document.nodes.every(n => !document.nodes.some(old => old.id === n.id)));
    assert.equal(duplicate.document.edges.length, 19);
    const bad = await app.inject({ ...request, payload: { ...request.payload, revision: 1, document: { ...document, schemaVersion: 99 } } });
    assert.equal(bad.statusCode, 400);
    const denied = await app.inject({ method: 'POST', url: '/api/projects', headers: { origin: 'https://example.com' }, payload: { name: 'untrusted' } });
    assert.equal(denied.statusCode, 403);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('SQLite migration and saved viewport survive closing and reopening database', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'drama-canvas-test-'));
  const filename = path.join(directory, 'test.sqlite');
  try {
    const first = new ProjectStore(filename), p = first.create('恢复测试', 'story');
    p.document.viewport = { x: 145, y: -42, zoom: 0.6 };
    first.save(p.id, p.revision, p.document, p.name); first.close();
    const second = new ProjectStore(filename);
    try { assert.deepEqual(second.get(p.id).document.viewport, p.document.viewport); assert.equal(second.get(p.id).revision, 1); }
    finally { second.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
