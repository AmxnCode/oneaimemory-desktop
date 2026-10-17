import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
// Type-only — erased at compile time, so this carries no runtime import
// specifier a bundler could see or mangle.
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.js';
import { embedText, cosineSimilarity, EMBEDDING_DIMS } from './embed.js';

// This has to run correctly in three different contexts: vitest (real
// ESM), plain-Node mcp-server (real ESM), and desktop's esbuild bundle
// (compiled to CJS). A plain `import ... from 'node:sqlite'` fails under
// vitest — it strips the `node:` prefix before Node ever sees the
// specifier, and unlike `fs`/`path` this builtin has no bare-name form, so
// resolution fails with "Cannot find package 'sqlite'". The obvious
// workaround, `createRequire(import.meta.url)`, then fails in the *other*
// direction: `import.meta.url` is empty once esbuild compiles this to CJS
// for desktop's bundle, so `createRequire` receives `undefined` and throws
// at runtime. `process.getBuiltinModule` sidesteps both — no import
// specifier or `import.meta` for any bundler or test runner to see, just a
// plain runtime property access. Needs Node >=22.3; see this package's own
// `engines` field.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

/**
 * Local-only memory index: SQLite + brute-force cosine similarity over
 * locally-computed embeddings, adapted from MemPalace's architecture
 * (github.com/milla-jovovich/mempalace) for OneConscious's constraints.
 *
 * Uses Node's built-in `node:sqlite` (stable since Node 22.5), not the
 * `better-sqlite3` npm package the original plan called for: that package
 * turned out to be broken against Electron 43's V8 (a raw `v8::External`
 * API call needs a new required argument that better-sqlite3's native
 * bindings don't pass yet — an upstream compat gap, not something fixable
 * here). `node:sqlite` ships compiled as part of the Node/V8 binary itself,
 * so there is no separate native addon to rebuild and no ABI to mismatch —
 * it always matches whatever Node/Electron version is actually running.
 * Trade-off: requires Node >=22.5 wherever this runs (fine for the
 * Electron-embedded copy, which bundles its own Node; a standalone
 * `mcp-server` install needs a recent-enough system Node — MemoryIndex
 * construction throws clearly if not, which callers degrade from rather
 * than crash on, same as any other optional capability in this app).
 *
 * Deliberately NOT synced anywhere, unlike every other piece of data this
 * app touches: it lives at a fixed path (~/.oneconscious/memory.db, not
 * Electron's userData) specifically so both the Electron-embedded MCP
 * server and a standalone `mcp-server` install can read it, but it is a
 * derived, rebuildable artifact — the source of truth is still the
 * encrypted `ai_session` events synced through the normal pipeline. If
 * this file were lost, re-ingesting the same local session logs rebuilds
 * it (ingestion is idempotent — see the UNIQUE constraint in schema.ts).
 * That's also why it's fine for this one file to be plaintext on disk in a
 * way nothing else in this app is.
 */

export function defaultDbPath(): string {
  return process.env.ONECON_MEMORY_DB_PATH ?? join(homedir(), '.oneconscious', 'memory.db');
}

export interface IngestChunk {
  tool: string;
  sessionId: string;
  turnIndex: number;
  chunkIndex: number;
  chunkCount: number;
  role: string;
  content: string;
  project?: string;
  cwd?: string;
}

export interface ScoredChunk {
  id: number;
  tool: string;
  sessionId: string;
  turnIndex: number;
  chunkIndex: number;
  role: string;
  content: string;
  project: string | null;
  cwd: string | null;
  createdAt: string;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  project?: string;
  /** Look-back window; default 90 days keeps the brute-force scan bounded — see class doc. */
  hours?: number;
  /**
   * Floor below which a result is dropped rather than padded in to fill
   * `limit`. Without this, a query with few genuinely related chunks (or a
   * small index overall) returns irrelevant filler just to hit the
   * requested count — caught by a real MCP round-trip test returning an
   * unrelated chunk alongside two on-topic ones. `neighbors()` already had
   * an equivalent `minScore`; `search()` didn't.
   */
  minScore?: number;
}

const DEFAULT_SEARCH_HOURS = 24 * 90;
const KEYWORD_WEIGHT = 0.15;
// All-MiniLM-L6-v2 cosine similarity for genuinely unrelated sentences
// typically sits under ~0.15; related-topic sentences score well above
// that. Conservative enough to keep true matches, not so tight it starts
// rejecting loosely-worded but real matches.
const DEFAULT_MIN_SCORE = 0.15;

function floatsToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

// node:sqlite returns BLOB columns as Uint8Array, not Buffer specifically —
// accept the wider type rather than assuming Buffer.
function blobToFloats(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

export class MemoryIndex {
  private db: DatabaseSyncType;

  constructor(dbPath: string = defaultDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA_SQL);
  }

  /** Idempotent: re-ingesting the same (sessionId, turnIndex, chunkIndex) is a no-op. */
  async ingest(chunk: IngestChunk): Promise<void> {
    const insertChunk = this.db.prepare(`
      INSERT OR IGNORE INTO memory_chunks
        (tool, session_id, turn_index, chunk_index, chunk_count, role, content, project, cwd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = insertChunk.run(
      chunk.tool,
      chunk.sessionId,
      chunk.turnIndex,
      chunk.chunkIndex,
      chunk.chunkCount,
      chunk.role,
      chunk.content,
      chunk.project ?? null,
      chunk.cwd ?? null,
    );
    if (info.changes === 0) return; // already ingested

    const vector = await embedText(chunk.content);
    this.db
      .prepare('INSERT OR REPLACE INTO memory_embeddings (chunk_id, vector, dims) VALUES (?, ?, ?)')
      .run(info.lastInsertRowid, floatsToBlob(vector), EMBEDDING_DIMS);
  }

  async search(query: string, opts: SearchOptions = {}): Promise<ScoredChunk[]> {
    const limit = opts.limit ?? 10;
    const hours = opts.hours ?? DEFAULT_SEARCH_HOURS;
    const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
    const since = new Date(Date.now() - hours * 3600_000).toISOString();

    const rows = this.candidateRows(since, opts.project);
    if (rows.length === 0) return [];

    const queryVec = await embedText(query);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    const scored = rows
      .map((row) => {
        const vec = blobToFloats(row.vector as Uint8Array);
        const sim = cosineSimilarity(queryVec, vec);
        const hay = row.content.toLowerCase();
        const hits = terms.filter((t) => hay.includes(t)).length;
        return { row, score: sim + hits * KEYWORD_WEIGHT };
      })
      .filter((s) => s.score >= minScore);

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ row, score }) => toScoredChunk(row, score));
  }

  /** Nearest neighbors of one chunk by embedding similarity — used for the graph view's edges. */
  async neighbors(chunkId: number, k: number, minScore: number): Promise<ScoredChunk[]> {
    const target = this.db
      .prepare('SELECT vector FROM memory_embeddings WHERE chunk_id = ?')
      .get(chunkId) as { vector: Uint8Array } | undefined;
    if (!target) return [];
    const targetVec = blobToFloats(target.vector);

    const rows = this.db
      .prepare(
        `SELECT c.*, e.vector FROM memory_chunks c
         JOIN memory_embeddings e ON e.chunk_id = c.id
         WHERE c.id != ?`,
      )
      .all(chunkId) as unknown as ChunkRow[];

    const scored = rows
      .map((row) => ({ row, score: cosineSimilarity(targetVec, blobToFloats(row.vector as Uint8Array)) }))
      .filter((s) => s.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    return scored.map(({ row, score }) => toScoredChunk(row, score));
  }

  /** For the graph view — most recent chunks, capped, no embedding compare needed. */
  listChunks(opts: { limit?: number; project?: string } = {}): ScoredChunk[] {
    const limit = opts.limit ?? 300;
    const rows = opts.project
      ? (this.db
          .prepare('SELECT * FROM memory_chunks WHERE project = ? ORDER BY created_at DESC LIMIT ?')
          .all(opts.project, limit) as unknown as ChunkRow[])
      : (this.db.prepare('SELECT * FROM memory_chunks ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as ChunkRow[]);
    return rows.map((row) => toScoredChunk(row, 0));
  }

  close(): void {
    this.db.close();
  }

  private candidateRows(since: string, project?: string): Array<ChunkRow & { vector: Uint8Array }> {
    const base = `
      SELECT c.*, e.vector FROM memory_chunks c
      JOIN memory_embeddings e ON e.chunk_id = c.id
      WHERE c.created_at >= ?
    `;
    if (project) {
      return this.db.prepare(base + ' AND c.project = ?').all(since, project) as unknown as Array<ChunkRow & { vector: Uint8Array }>;
    }
    return this.db.prepare(base).all(since) as unknown as Array<ChunkRow & { vector: Uint8Array }>;
  }
}

interface ChunkRow {
  id: number;
  tool: string;
  session_id: string;
  turn_index: number;
  chunk_index: number;
  chunk_count: number;
  role: string;
  content: string;
  project: string | null;
  cwd: string | null;
  created_at: string;
  vector?: unknown;
}

function toScoredChunk(row: ChunkRow, score: number): ScoredChunk {
  return {
    id: row.id,
    tool: row.tool,
    sessionId: row.session_id,
    turnIndex: row.turn_index,
    chunkIndex: row.chunk_index,
    role: row.role,
    content: row.content,
    project: row.project,
    cwd: row.cwd,
    createdAt: row.created_at,
    score,
  };
}
