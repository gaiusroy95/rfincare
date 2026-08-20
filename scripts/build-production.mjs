#!/usr/bin/env node
/**
 * Compile backend/src → backend/dist using esbuild (no source maps).
 * Preserves module layout so import.meta.url path resolution keeps working.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(__dirname, '..');
const srcRoot = join(backendRoot, 'src');
const distRoot = join(backendRoot, 'dist');

function collectJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

function assertDistSafe() {
  const rel = relative(srcRoot, distRoot);
  if (!rel.startsWith('..') && !rel.includes('src')) {
    throw new Error('Refusing to overwrite dist inside src');
  }
}

async function main() {
  assertDistSafe();
  const entryPoints = collectJsFiles(srcRoot);
  if (!entryPoints.length) {
    throw new Error(`No JavaScript entry files found under ${srcRoot}`);
  }

  rmSync(distRoot, { recursive: true, force: true });

  await esbuild.build({
    entryPoints,
    outdir: distRoot,
    outbase: srcRoot,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    sourcemap: false,
    logLevel: 'info',
    legalComments: 'none',
    charset: 'utf8',
  });

  console.log(`[build-production] Compiled ${entryPoints.length} files → ${distRoot}`);
}

main().catch((err) => {
  console.error('[build-production] Failed:', err.message || err);
  process.exit(1);
});
