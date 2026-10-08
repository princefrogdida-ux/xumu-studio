import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DocumentSchema, emptyDocument, storyDocument, referencedAssetIds, isGenerationNode, type Asset, type CanvasDocument, type Project, type ProjectSummary } from '../../../../packages/shared/src/index.ts';
import type { Generation } from '../../../../packages/shared/src/generation.ts';

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class ValidationError extends Error {}
export type StoredAsset = Omit<Asset, 'status'> & { filename: string; thumbnail: string | null; outputIndex?: number };

export class ProjectStore {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    try { this.migrate(); } catch (error) { this.db.close(); throw error; }
  }
  private migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    // API and worker may start together. Lock before reading migration state.
    this.db.exec('BEGIN IMMEDIATE');
    try {
    const applied = this.db.prepare('SELECT MAX(version) AS version FROM migrations').get() as { version: number | null };
    if ((applied.version ?? 0) > 5) throw new Error('数据库版本高于当前程序，请使用更新版本；原数据未修改。');
    if (!applied.version) {
        this.db.exec(`CREATE TABLE projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
          document TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )`);
        this.db.prepare('INSERT INTO migrations VALUES (?, ?)').run(1, new Date().toISOString());
    }
    if ((applied.version ?? 0) < 2) {
        this.db.exec(`CREATE TABLE assets (id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
          CREATE TABLE project_assets (project_id TEXT NOT NULL REFERENCES projects(id), asset_id TEXT NOT NULL REFERENCES assets(id), PRIMARY KEY(project_id, asset_id));`);
        // Upgrade atomically: a bad document rolls back the entire migration.
        const rows = this.db.prepare('SELECT id, document FROM projects').all() as { id: string; document: string }[];
        for (const row of rows) this.db.prepare('UPDATE projects SET document = ? WHERE id = ?').run(JSON.stringify(DocumentSchema.parse(JSON.parse(row.document))), row.id);
        this.db.prepare('INSERT INTO migrations VALUES (?, ?)').run(2, new Date().toISOString());
    }
    if ((applied.version ?? 0) < 3) {
        this.db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), node_id TEXT NOT NULL,
          request_key TEXT NOT NULL, status TEXT NOT NULL, lease_until INTEGER, next_poll_at INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(project_id, request_key));
          CREATE INDEX tasks_work ON tasks(status, next_poll_at);
          CREATE TABLE generations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), data TEXT NOT NULL);
          CREATE TABLE mock_jobs (id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
          CREATE TABLE worker_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, lease_until INTEGER NOT NULL);`);
        const rows = this.db.prepare('SELECT id, document FROM projects').all() as { id: string; document: string }[];
        for (const row of rows) this.db.prepare('UPDATE projects SET document = ? WHERE id = ?').run(JSON.stringify(DocumentSchema.parse(JSON.parse(row.document))), row.id);
        this.db.prepare('INSERT INTO migrations VALUES (?, ?)').run(3, new Date().toISOString());
    }
    if ((applied.version ?? 0) < 4) {
      const rows = this.db.prepare('SELECT id, document FROM projects').all() as { id: string; document: string }[];
      for (const row of rows) this.db.prepare('UPDATE projects SET document = ? WHERE id = ?').run(JSON.stringify(DocumentSchema.parse(JSON.parse(row.document))), row.id);
      this.db.prepare('INSERT INTO migrations VALUES (?, ?)').run(4, new Date().toISOString());
    }
    if ((applied.version ?? 0) < 5) {
      this.db.exec(`CREATE INDEX tasks_project_node ON tasks(project_id, node_id);
        CREATE INDEX tasks_project_status ON tasks(project_id, status);
        CREATE INDEX tasks_project_history ON tasks(project_id);
        CREATE TABLE worker_health (id INTEGER PRIMARY KEY CHECK(id=1), seen_at INTEGER NOT NULL, stopped INTEGER NOT NULL);`);
      this.db.prepare('INSERT INTO migrations VALUES (?, ?)').run(5, new Date().toISOString());
    }
    this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id: string): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as {
      id: string; name: string; revision: number; document: string; created_at: string; updated_at: string;
    } | undefined;
    if (!row) throw new NotFoundError('项目不存在');
    return { id: row.id, name: row.name, revision: row.revision,
      document: DocumentSchema.parse(JSON.parse(row.document)), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  list(): ProjectSummary[] {
    const rows = this.db.prepare('SELECT id FROM projects ORDER BY updated_at DESC').all() as { id: string }[];
    return rows.map(({ id }) => { const { document, ...rest } = this.get(id); return { ...rest, nodeCount: document.nodes.length }; });
  }
  create(name: string, template: 'empty' | 'story' = 'empty'): Project {
    const id = randomUUID(), now = new Date().toISOString();
    const doc = template === 'story' ? storyDocument(randomUUID) : emptyDocument();
    this.db.prepare('INSERT INTO projects VALUES (?, ?, 0, ?, ?, ?)').run(id, name, JSON.stringify(doc), now, now);
    return this.get(id);
  }
  save(id: string, revision: number, document: CanvasDocument, name: string): Project {
    const parsed = DocumentSchema.parse(document);
    const assets = this.assets(id);
    for (const assetId of referencedAssetIds(parsed)) if (!assets.some(a => a.id === assetId)) throw new ValidationError('素材不存在或不属于当前项目');
    for (const ref of parsed.references) if (ref.assetIds.some(id => assets.find(a => a.id === id)?.mediaType !== 'image')) throw new ValidationError('角色和场景只能引用图片素材');
    for (const node of parsed.nodes) if (node.type === 'media' && assets.find(a => a.id === node.data.assetId)?.mediaType !== node.data.mediaType) throw new ValidationError('素材类型与节点不一致');
    for (const shot of parsed.shots) for (const [assetId, kind] of [[shot.selectedImageAssetId, 'image'], [shot.selectedVideoAssetId, 'video']])
      if (assetId && assets.find(a => a.id === assetId)?.mediaType !== kind) throw new ValidationError('镜头选用素材类型无效');
    for (const node of parsed.nodes) if (isGenerationNode(node)) {
      if (node.data.selectedAssetId && (node.type === 'script' || assets.find(a => a.id === node.data.selectedAssetId)?.mediaType !== (node.type === 'imageGenerate' ? 'image' : 'video'))) throw new ValidationError('生成节点选中素材类型无效');
      if (node.data.selectedGenerationId) {
        const row = this.db.prepare('SELECT data FROM generations WHERE id = ? AND project_id = ?').get(node.data.selectedGenerationId, id) as { data: string } | undefined;
        const generation: Generation | undefined = row ? JSON.parse(row.data) : undefined;
        if (!generation || generation.nodeId !== node.id || !generation.outputAssetIds.includes(node.data.selectedAssetId ?? '')) throw new ValidationError('选中版本不属于当前节点');
      }
    }
    const result = this.db.prepare('UPDATE projects SET document = ?, name = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?')
      .run(JSON.stringify(parsed), name, new Date().toISOString(), id, revision);
    if (!result.changes) {
      this.get(id);
      throw new ConflictError('项目已在其他页面更新。请导出当前草稿或读取最新版本，避免覆盖。');
    }
    return this.get(id);
  }
  duplicate(id: string): Project {
    const original = this.get(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
    const copy = this.create(`${original.name.slice(0, 100)} · 副本`);
    this.db.prepare('INSERT INTO project_assets SELECT ?, asset_id FROM project_assets WHERE project_id = ?').run(copy.id, id);
    const mapping = new Map(original.document.nodes.map(n => [n.id, randomUUID()]));
    const document = structuredClone(original.document);
    document.nodes.forEach(n => { n.id = mapping.get(n.id)!; });
    document.edges = document.edges.map(e => ({ ...e, id: randomUUID(), source: mapping.get(e.source)!, target: mapping.get(e.target)! }));
    const refIds = new Map(document.references.map(r => [r.id, randomUUID()])), shotIds = new Map(document.shots.map(s => [s.id, randomUUID()]));
    document.references.forEach(r => { r.id = refIds.get(r.id)!; });
    document.shots.forEach(s => { s.id = shotIds.get(s.id)!; s.sceneId = s.sceneId ? refIds.get(s.sceneId)! : null; s.characterIds = s.characterIds.map(id => refIds.get(id)!); });
    document.nodes.forEach(n => { if (n.type === 'shot') n.data.shotId = shotIds.get(n.data.shotId)!; if (n.type === 'reference') n.data.referenceId = refIds.get(n.data.referenceId)!;
      if (isGenerationNode(n)) { n.data.selectedGenerationId = null; n.data.shotId = n.data.shotId ? shotIds.get(n.data.shotId)! : null; }
    });
    const result = this.save(copy.id, 0, document, copy.name);
    this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  assets(projectId: string): StoredAsset[] {
    return (this.db.prepare('SELECT a.metadata FROM assets a JOIN project_assets p ON p.asset_id = a.id WHERE p.project_id = ? ORDER BY a.rowid DESC').all(projectId) as { metadata: string }[]).map(r => JSON.parse(r.metadata));
  }
  asset(id: string): StoredAsset {
    const row = this.db.prepare('SELECT metadata FROM assets WHERE id = ?').get(id) as { metadata: string } | undefined;
    if (!row) throw new NotFoundError('素材记录不存在');
    return JSON.parse(row.metadata);
  }
  addAsset(projectId: string, asset: StoredAsset) {
    this.get(projectId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO assets VALUES (?, ?)').run(asset.id, JSON.stringify(asset));
      this.db.prepare('INSERT INTO project_assets VALUES (?, ?)').run(projectId, asset.id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
