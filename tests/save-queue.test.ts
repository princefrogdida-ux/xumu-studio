import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SaveQueue } from '../apps/web/src/lib/save-queue.ts';
import { ApiError } from '../apps/web/src/lib/api.ts';
import { storyDocument, type Project } from '../packages/shared/src/index.ts';

const project = (): Project => ({ id: 'project', name: 'project', revision: 0, createdAt: '', updatedAt: '', document: storyDocument(randomUUID) });

test('save queue serializes concurrent flushes and sends edits arriving during a save', async () => {
  const p = project(), calls: number[] = [], names: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queue = new SaveQueue(p, async (revision, snapshot) => {
    calls.push(revision); names.push(snapshot.name);
    if (calls.length === 1) await gate;
    return { ...p, ...snapshot, revision: revision + 1 };
  }, () => {}, () => {}, 10000);
  queue.queue(p.document, 'first');
  const a = queue.flush();
  queue.queue(p.document, 'second');
  const b = queue.flush();
  release(); await Promise.all([a, b]);
  assert.deepEqual(calls, [0, 1]); assert.deepEqual(names, ['first', 'second']);
  assert.equal(queue.status, 'saved'); assert.equal(queue.dirty, false); queue.stop();
});

test('conflicts preserve dirty state and do not silently retry', async () => {
  const p = project(); let calls = 0, cleared = false;
  const queue = new SaveQueue(p, async () => { calls++; throw new ApiError(409, 'conflict'); }, () => {}, snapshot => { if (!snapshot) cleared = true; }, 10000);
  queue.queue(p.document, 'edit'); await assert.rejects(queue.flush());
  queue.queue(p.document, 'new edit'); await assert.rejects(queue.flush());
  assert.equal(calls, 1); assert.equal(queue.dirty, true); assert.equal(cleared, false); assert.equal(queue.status, 'conflict'); queue.stop();
});

test('temporary save failure keeps draft and can be explicitly retried', async () => {
  const p = project(); let calls = 0; const draftStates: boolean[] = [];
  const queue = new SaveQueue(p, async (revision, snapshot) => {
    if (++calls === 1) throw new Error('network unavailable');
    return { ...p, ...snapshot, revision: revision + 1 };
  }, () => {}, snapshot => draftStates.push(snapshot !== null), 10000);
  queue.queue(p.document, 'unsaved'); await assert.rejects(queue.flush());
  assert.equal(queue.status, 'error'); assert.equal(queue.dirty, true);
  assert.deepEqual(draftStates, [true]);
  await queue.flush();
  assert.equal(queue.status, 'saved'); assert.equal(queue.dirty, false);
  assert.deepEqual(draftStates, [true, false]); queue.stop();
});
