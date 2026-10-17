import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

/**
 * Bundle to CommonJS. The shared package is ESM-only, and Electron's main
 * process loads CJS here — bundling sidesteps the interop problem entirely and
 * keeps startup fast.
 */
// @huggingface/transformers loads its ONNX runtime as WASM at runtime — that
// can't be bundled into a single JS file by esbuild, WASM loading has to
// stay a real require() against node_modules (see build config's
// asarUnpack). @oneconscious/memory's SQLite layer is node:sqlite, a Node
// builtin — esbuild externalizes node:-prefixed imports automatically, no
// entry needed here for that. @oneconscious/memory itself (the package that
// depends on transformers) still bundles normally; only the WASM runtime
// does not.
const NATIVE_EXTERNALS = ['@huggingface/transformers'];

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron', ...NATIVE_EXTERNALS],
  sourcemap: true,
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs' });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs' });

// Bundle the MCP server for embedding in the Electron app
await build({
  ...common,
  entryPoints: ['./mcp-server/src/server.ts'],
  outfile: 'dist/mcp-server.cjs',
  // MCP server needs these as externals since they're ESM-only
  external: ['electron', '@modelcontextprotocol/sdk', ...NATIVE_EXTERNALS],
});

mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer', 'dist/renderer', { recursive: true });

console.log('desktop build complete');
