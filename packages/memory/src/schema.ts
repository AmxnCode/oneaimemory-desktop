/**
 * Embedded as a TS string, not a separate .sql file: this package is
 * consumed by both plain-Node `mcp-server` (tsc-compiled dist/) and the
 * Electron desktop app (esbuild-bundled into a single main.cjs) — a sibling
 * file wouldn't be resolvable at runtime in the bundled case, so the schema
 * has to travel as code, not as an asset.
 *
 * Local-only, plaintext memory index — deliberately NOT synced anywhere.
 * See index.ts's top-of-file comment for why that's safe despite living
 * outside the app's usual encrypted-at-rest model.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tool        TEXT    NOT NULL,
  session_id  TEXT    NOT NULL,
  turn_index  INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  role        TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  project     TEXT,
  cwd         TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (session_id, turn_index, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_session ON memory_chunks(session_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_created ON memory_chunks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_project ON memory_chunks(project);

-- One embedding per chunk. \`vector\` is a Float32Array's raw bytes (see
-- embed.ts) — brute-force cosine similarity over these at query time, no
-- vector-index extension. Fine at personal-data scale; see index.ts.
CREATE TABLE IF NOT EXISTS memory_embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES memory_chunks(id) ON DELETE CASCADE,
  vector   BLOB    NOT NULL,
  dims     INTEGER NOT NULL
);
`;
