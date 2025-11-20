#!/usr/bin/env node

/**
 * Builds the Rust solver with aggressive CPU-specific optimizations.
 *
 * We dynamically tailor RUSTFLAGS depending on the host platform/arch so the
 * user can just run `npm run build:solver` and always get the best binary
 * the machine can support.
 */

import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const platform = os.platform();
const arch = os.arch();

const flagParts = [
  '-C target-cpu=native',
  '-C llvm-args=--inline-threshold=1000',
  '-C prefer-dynamic=no'
];

if (platform !== 'win32') {
  flagParts.push('-C link-arg=-s');
}

const featureMatrix = {
  x64: ['+aes', '+sse2', '+sse3', '+ssse3', '+sse4.1', '+sse4.2', '+avx', '+avx2', '+fma'],
  ia32: ['+mmx', '+sse', '+sse2', '+sse3', '+ssse3', '+sse4.1', '+sse4.2'],
  arm64: ['+neon', '+crypto', '+crc', '+dotprod', '+fp16'],
  arm: ['+neon', '+crypto', '+crc'],
  riscv64: ['+m', '+a', '+f', '+d', '+zba', '+zbb', '+zbc']
};

const overrideFeatures = (process.env.RUST_TARGET_FEATURES || process.env.TARGET_FEATURES || '')
  .split(',')
  .map((token) => token.trim())
  .filter(Boolean);

const featureList =
  overrideFeatures.length > 0 ? overrideFeatures : featureMatrix[arch] ?? null;

if (featureList && featureList.length) {
  flagParts.push(`-C target-feature=${featureList.join(',')}`);
}

const rustflags = flagParts.join(' ');
const env = { ...process.env, RUSTFLAGS: rustflags };

console.log(`[build-solver] Target: ${platform}/${arch}`);
console.log(`[build-solver] Using RUSTFLAGS="${rustflags}"`);

const cargoArgs = ['build', '--release', '--bin', 'solve-batch'];
const solverDir = fileURLToPath(new URL('../solver', import.meta.url));

const child = spawn('cargo', cargoArgs, {
  cwd: solverDir,
  env,
  stdio: 'inherit'
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error('[build-solver] Failed to invoke cargo:', error);
  process.exit(1);
});

