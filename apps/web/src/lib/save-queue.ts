import type { CanvasDocument, Project } from '../../../../packages/shared/src/index.ts';

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error' | 'conflict';
type Snapshot = { document: CanvasDocument; name: string };

/** Serializes saves so an old response never replaces newer edits or revisions. */
export class SaveQueue {
  status: SaveStatus = 'saved';
  error = '';
  revision: number;
  private latest: Snapshot;
  private sequence = 0;
  private savedSequence = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private flight?: Promise<void>;
  private stopped = false;
  constructor(
    project: Project,
    private send: (revision: number, snapshot: Snapshot) => Promise<Project>,
    private notify: (status: SaveStatus, error: string) => void,
    private draft: (snapshot: Snapshot | null, revision: number) => void,
    private delay = 850,
  ) { this.revision = project.revision; this.latest = { document: project.document, name: project.name }; }

  private set(status: SaveStatus, error = '') {
    this.status = status; this.error = error;
    if (!this.stopped) this.notify(status, error);
  }
  get dirty() { return this.sequence !== this.savedSequence; }
  queue(document: CanvasDocument, name: string) {
    if (this.stopped) return;
    this.latest = { document: structuredClone(document), name };
    this.sequence++;
    this.draft(this.latest, this.revision);
    clearTimeout(this.timer);
    if (this.status === 'conflict') return;
    this.set('pending');
    this.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, this.delay);
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.status === 'conflict') throw new Error(this.error);
    if (this.flight) {
      await this.flight;
      if (this.dirty) return this.flush();
      return;
    }
    if (!this.dirty || this.stopped) return;
    const sequence = this.sequence, snapshot = structuredClone(this.latest);
    this.set('saving');
    this.flight = (async () => {
      try {
        const result = await this.send(this.revision, snapshot);
        this.revision = result.revision;
        this.savedSequence = sequence;
        if (!this.dirty) this.draft(null, this.revision);
        else this.draft(this.latest, this.revision);
        this.set(this.dirty ? 'pending' : 'saved');
      } catch (error) {
        this.set((error as { status?: number }).status === 409 ? 'conflict' : 'error', error instanceof Error ? error.message : '保存失败');
        throw error;
      } finally { this.flight = undefined; }
    })();
    await this.flight;
    if (this.dirty) return this.flush();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
}
