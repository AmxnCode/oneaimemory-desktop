import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryIndex, type IngestChunk } from '../index.js';

// Real embeddings, not mocked — this is exactly the seam the whole hybrid
// search design depends on, so a fake similarity function would validate
// nothing. First run downloads the ~30MB model (see vitest.config.ts's
// generous testTimeout); cached under a tmp dir after that.
describe('MemoryIndex', () => {
  let dir: string;
  let index: MemoryIndex;

  const chunk = (over: Partial<IngestChunk>): IngestChunk => ({
    tool: 'claude-code',
    sessionId: 's-1',
    turnIndex: 0,
    chunkIndex: 0,
    chunkCount: 1,
    role: 'user',
    content: 'placeholder',
    ...over,
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oneconscious-memory-test-'));
    process.env.ONECON_MEMORY_MODEL_CACHE = join(dir, 'models');
    index = new MemoryIndex(join(dir, 'memory.db'));

    // Distinct-topic fixtures — the real test of a working embedding index
    // is that semantically related text ranks above unrelated text, not
    // just that *something* comes back.
    await index.ingest(chunk({ turnIndex: 0, content: 'How do I configure a PostgreSQL database connection pool?' }));
    await index.ingest(chunk({ turnIndex: 1, content: 'What is the best recipe for a chocolate birthday cake?' }));
    await index.ingest(chunk({ turnIndex: 2, content: 'Explain how connection pooling works for Postgres in Node.js' }));
    await index.ingest(chunk({ turnIndex: 3, content: 'My cat knocked a vase off the shelf this morning' }));
  }, 60_000);

  afterAll(() => {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ranks the semantically related chunk above unrelated ones for a database query', async () => {
    const results = await index.search('database connection configuration', { limit: 4 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toContain('PostgreSQL');
    // The unrelated cat/cake chunks should not outrank both database chunks.
    const topTwo = results.slice(0, 2).map((r) => r.content);
    expect(topTwo.some((c) => c.includes('Postgres'))).toBe(true);
  });

  it('scores an unrelated query below the topical ones', async () => {
    const results = await index.search('birthday cake recipe', { limit: 4 });
    expect(results[0]!.content).toContain('cake');
  });

  it('does not pad results with irrelevant chunks just to fill a high limit', async () => {
    // Regression test: caught via a real MCP tools/call round-trip where a
    // 3-chunk index (2 on-topic, 1 completely unrelated) with limit=5
    // returned all 3 — search() had no floor, only neighbors() did.
    const results = await index.search('database connection pooling', { limit: 10 });
    expect(results.every((r) => !r.content.includes('cat knocked'))).toBe(true);
  });

  it('is idempotent — re-ingesting the same chunk does not duplicate it', async () => {
    await index.ingest(chunk({ turnIndex: 0, content: 'How do I configure a PostgreSQL database connection pool?' }));
    const all = index.listChunks({ limit: 100 });
    const dupes = all.filter((c) => c.turnIndex === 0 && c.sessionId === 's-1');
    expect(dupes.length).toBe(1);
  });

  it('finds neighbors of a chunk above a similarity floor, and excludes clearly unrelated ones', async () => {
    const all = index.listChunks({ limit: 100 });
    const dbChunk = all.find((c) => c.content.includes('PostgreSQL'))!;
    const neighbors = await index.neighbors(dbChunk.id, 5, 0.3);
    expect(neighbors.some((n) => n.content.includes('pooling'))).toBe(true);
    expect(neighbors.every((n) => !n.content.includes('cat knocked'))).toBe(true);
  });

  it('applies a keyword-hit bonus on top of semantic score', async () => {
    // A literal substring match ("PostgreSQL") should score at least as
    // well as pure semantic similarity would alone.
    const results = await index.search('PostgreSQL', { limit: 4 });
    expect(results[0]!.content).toContain('PostgreSQL');
  });

  it('respects the project filter', async () => {
    await index.ingest(
      chunk({ sessionId: 's-2', turnIndex: 0, content: 'unrelated project-scoped content about widgets', project: 'other-project' }),
    );
    const results = await index.search('widgets', { project: 'other-project', limit: 10 });
    expect(results.length).toBe(1);
    expect(results[0]!.project).toBe('other-project');
  });
});
