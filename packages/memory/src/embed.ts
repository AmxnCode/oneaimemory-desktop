import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Local, no-API-key embeddings via transformers.js — same reasoning
 * MemPalace (github.com/milla-jovovich/mempalace) used: a WASM backend
 * means no native compilation, which matters a lot given this repo already
 * fought through native-module pain on Windows this session. ~30MB model,
 * downloaded once and cached under ~/.oneconscious/models.
 */

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMS = 384;

// Lazy singleton — constructing the pipeline loads the model, so it only
// happens once, on first real use, not at module import time.
let extractorPromise: Promise<FeatureExtractionFn> | null = null;

type FeatureExtractionFn = (
  text: string,
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array }>;

async function getExtractor(): Promise<FeatureExtractionFn> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { env, pipeline } = await import('@huggingface/transformers');
      env.cacheDir = process.env.ONECON_MEMORY_MODEL_CACHE ?? join(homedir(), '.oneconscious', 'models');
      const extractor = await pipeline('feature-extraction', MODEL_ID);
      return extractor as unknown as FeatureExtractionFn;
    })();
  }
  return extractorPromise;
}

export async function embedText(text: string): Promise<Float32Array> {
  const extractor = await getExtractor();
  // Truncate defensively — the model has its own token limit (256 for
  // MiniLM) well under our 4000-char chunk cap; transformers.js truncates
  // internally, but capping the input here keeps that cost predictable.
  const result = await extractor(text.slice(0, 4000), { pooling: 'mean', normalize: true });
  return result.data;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  // Both vectors are already L2-normalized (normalize: true above), so the
  // dot product alone *is* the cosine similarity — no need to divide by
  // magnitudes on every comparison.
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}
