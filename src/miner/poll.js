#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePaths, apiEndpoints } from '../config/index.js';

const parseArgs = (argv = process.argv.slice(2)) => {
  const parsed = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value && !value.startsWith('--')) {
        parsed[key] = value;
        i += 1;
      } else {
        parsed[key] = true;
      }
    }
  }

  return parsed;
};

const PATHS = resolvePaths();
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = PATHS.projectRoot;
const OUTPUT_DIR = PATHS.challengeCache;
const SOLVER_SCRIPT = path.join(MODULE_DIR, 'automate-solver.js');
const DATA_FINAL_DIR = PATHS.miningRoot;

let RAW_START = null;
let RAW_END = null;
let RAW_BATCH = null;
const DEFAULT_BATCH_SIZE = 1;
let BATCH_SIZE = DEFAULT_BATCH_SIZE;
const RECEIPT_CHECK_COUNT = Number(process.env.CHALLENGE_RECEIPT_CHECK_COUNT ?? 5);
const RECEIPT_SCAN_VERBOSE = process.env.CHALLENGE_RECEIPT_SCAN_VERBOSE === '1';
const CHALLENGE_URL = apiEndpoints.challenge();
const POLL_INTERVAL_MS = Number(process.env.CHALLENGE_POLL_INTERVAL_MS ?? 15_000);
const REQUEST_HEADERS = {
  'sec-fetch-user': '?1',
  'sec-ch-ua-platform': '"Windows"',
  referer: 'https://mine.defensio.io/wizard/wallet',
  referer: 'https://mine.defensio.io/wizard/wallet',
  'accept-language': 'frp,fr-FR;q=0.9,br;q=0.8',
  'sec-fetch-site': 'same-site',
  'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
  'sec-ch-ua-mobile': '?0',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  'accept-encoding': 'gzip, deflate, br, zstd',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'content-type': 'application/json'
};

// Hardening: never let unexpected errors or rejections kill the poller
process.on('uncaughtException', (err) => {
  try {
    console.error(`[${new Date().toISOString()}] Uncaught exception:`, err);
  } catch {}
});
process.on('unhandledRejection', (reason) => {
  try {
    console.error(`[${new Date().toISOString()}] Unhandled rejection:`, reason);
  } catch {}
});
// Defensive: ignore stray SIGTERM (we explicitly SIGTERM children only)
process.on('SIGTERM', () => {
  console.warn(`[${new Date().toISOString()}] Received SIGTERM in poller; ignoring (workers are signaled separately).`);
});

// Solution submission base URL (same as in automate-solver.js)
const SUBMIT_URL_BASE = apiEndpoints.solution();

// Optional: block rotation until fast backlog finishes (bounded by timeout)
const FAST_BACKLOG_BLOCK = process.env.FAST_BACKLOG_BLOCK === '1';
const FAST_BACKLOG_TIMEOUT_MS = Number(process.env.FAST_BACKLOG_TIMEOUT_MS ?? 15000);
// Soft-rotate: wait for current batch to finish before starting new challenge.
// 0 means wait indefinitely.
const SOFT_ROTATE_TIMEOUT_MS = Number(process.env.SOFT_ROTATE_TIMEOUT_MS ?? 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const activeSolverRuns = new Map();
let currentBatchToken = null;

// Identify a challenge uniquely by campaign day and challenge_number (DD-CC).
// This avoids false positives when the challenge payload body changes but the
// actual challenge identity has not rotated yet (e.g., fields like
// latest_submission or issued_at get tweaked).
const getChallengeKey = (challenge) => {
  const ch = challenge?.challenge ?? challenge;
  const day = Number(ch?.day ?? NaN);
  const num = Number(ch?.challenge_number ?? NaN);
  if (Number.isFinite(day) && Number.isFinite(num)) {
    const dd = String(Math.max(0, day)).padStart(2, '0');
    const cc = String(Math.max(0, num)).padStart(2, '0');
    return `${dd}-${cc}`;
  }
  // Fallback: try to parse from challenge_id ending with DddCcc
  const id = ch?.challenge_id ?? ch?.challengeId ?? '';
  const m = typeof id === 'string' ? id.match(/D(\d{2})C(\d{2})$/) : null;
  if (m) return `${m[1]}-${m[2]}`;
  return null;
};

const cancelCurrentBatchSequence = () => {
  if (currentBatchToken) {
    currentBatchToken.cancelled = true;
  }
};

const stopAllSolverRuns = async (opts = { awaitExit: true }) => {
  cancelCurrentBatchSequence();

  if (activeSolverRuns.size === 0) {
    return;
  }

  console.log(
    `[${new Date().toISOString()}] Stopping ${activeSolverRuns.size} active automate-solver run(s) before processing new challenge...`
  );

  const stopPromises = [];
  for (const [child, metadata] of activeSolverRuns.entries()) {
    if (child.exitCode !== null || child.signalCode !== null || child.killed) {
      continue;
    }

    if (opts.awaitExit) {
      stopPromises.push(
        new Promise((resolve) => {
          child.once('exit', () => resolve());
          child.once('error', () => resolve());
        })
      );
    }

    const killed = child.kill('SIGTERM');
    const challengeSnippet = metadata?.challengeHash?.slice(0, 12) ?? 'unknown';
    const rangeLabel = metadata ? `${metadata.startIndex}-${metadata.endIndex}` : 'unknown';
    if (!killed) {
      console.warn(
        `[${new Date().toISOString()}] Failed to send SIGTERM to automate-solver for challenge ${challengeSnippet} (wallets ${rangeLabel})`
      );
    } else {
      console.log(
        `[${new Date().toISOString()}] Sent SIGTERM to automate-solver for challenge ${challengeSnippet} (wallets ${rangeLabel})`
      );
    }
  }

  if (opts.awaitExit && stopPromises.length > 0) {
    await Promise.allSettled(stopPromises);
    console.log(`[${new Date().toISOString()}] All previous automate-solver runs stopped.`);
  }
};

const getReceiptFilePath = (walletId) =>
  path.join(DATA_FINAL_DIR, String(walletId), 'challenge_receipt.json');

// Minimal helpers to load/save per-wallet receipts locally
const loadReceipts = async (walletFolder) => {
  const receiptFile = getReceiptFilePath(walletFolder);
  try {
    const data = await fs.readFile(receiptFile, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
};

const saveReceipts = async (walletFolder, receipts) => {
  const receiptFile = getReceiptFilePath(walletFolder);
  await fs.mkdir(path.dirname(receiptFile), { recursive: true });
  await fs.writeFile(
    receiptFile,
    JSON.stringify(receipts ?? [], null, 2) + '\n',
    'utf8'
  );
};

const extractReceiptsArray = (data) => {
  if (!data) {
    return [];
  }

  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data.receipts)) {
    return data.receipts;
  }

  if (Array.isArray(data.entries)) {
    return data.entries;
  }

  return [];
};

const receiptContainsChallenge = (receipts, challengeId) => {
  if (!challengeId || !Array.isArray(receipts)) {
    return false;
  }

  return receipts.some((receipt) => {
    if (!receipt || typeof receipt !== 'object') {
      return false;
    }

    const receiptChallengeId =
      receipt.challengeId ?? receipt.challenge_id ?? receipt.challenge?.challenge_id ?? null;

    return receiptChallengeId === challengeId;
  });
};

// Check if a receipt for a challenge is confirmed (validated)
const receiptIsConfirmed = (receipts, challengeId) => {
  if (!challengeId || !Array.isArray(receipts)) {
    return false;
  }

  return receipts.some((receipt) => {
    if (!receipt || typeof receipt !== 'object') {
      return false;
    }

    const receiptChallengeId =
      receipt.challengeId ?? receipt.challenge_id ?? receipt.challenge?.challenge_id ?? null;

    if (receiptChallengeId !== challengeId) {
      return false;
    }

    // Receipt is confirmed if status is 'validated' or validatedAt is not null
    const status = receipt.status;
    const validatedAt = receipt.validatedAt;
    return status === 'validated' || (validatedAt !== null && validatedAt !== undefined);
  });
};

// Check if all wallets have confirmed receipts for a challenge
const allWalletsHaveConfirmedReceipts = async (challengePayload) => {
  const challengeId = challengePayload?.challenge_id ?? challengePayload?.challengeId ?? null;
  if (!challengeId) {
    return false;
  }

  const walletIds = await listWalletIds();
  if (walletIds.length === 0) return false;

  for (const walletId of walletIds) {
    const receiptPath = getReceiptFilePath(walletId);
    let receipts = [];
    try {
      const content = await fs.readFile(receiptPath, 'utf8');
      const parsed = JSON.parse(content);
      receipts = extractReceiptsArray(parsed);
    } catch (error) {
      // Missing file or parse error means not confirmed
      return false;
    }

    if (!receiptIsConfirmed(receipts, challengeId)) {
      return false;
    }
  }

  return true;
};

// List numeric wallet folder IDs, sorted ascending
const listWalletIds = async () => {
  try {
    const items = await fs.readdir(DATA_FINAL_DIR, { withFileTypes: true });
    return items
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => /^\d+$/.test(name))
      .map((n) => Number(n))
      .sort((a, b) => a - b);
  } catch (err) {
    console.warn(`[${new Date().toISOString()}] Failed to read '${DATA_FINAL_DIR}': ${err.message}`);
    return [];
  }
};

const isChallengePresentInSampleReceipts = async (challengePayload) => {
  if (RECEIPT_CHECK_COUNT <= 0) {
    return false; // do not skip; proceed with automation
  }

  const challengeId = challengePayload?.challenge_id ?? challengePayload?.challengeId ?? null;
  if (!challengeId) {
    return false;
  }

  const walletIds = await listWalletIds();
  if (walletIds.length === 0) return false;

  const chunk = Math.max(1, Math.min(RECEIPT_CHECK_COUNT, walletIds.length));
  for (let i = 0; i < walletIds.length; i += chunk) {
    const sample = walletIds.slice(i, i + chunk);
    let anyUnsolved = false;

    for (const walletId of sample) {
      const receiptPath = getReceiptFilePath(walletId);
      let receipts = [];
      try {
        const content = await fs.readFile(receiptPath, 'utf8');
        const parsed = JSON.parse(content);
        receipts = extractReceiptsArray(parsed);
      } catch (error) {
        if (RECEIPT_SCAN_VERBOSE) {
          if (error.code !== 'ENOENT') {
            console.warn(
              `[${new Date().toISOString()}] Failed to read receipts for wallet ${walletId}: ${error.message}`
            );
          } else {
            console.log(
              `[${new Date().toISOString()}] Receipts file missing for wallet ${walletId}; treating as not solved.`
            );
          }
        }
        anyUnsolved = true; // missing file counts as not solved
        continue;
      }

      if (receiptContainsChallenge(receipts, challengeId)) {
        if (RECEIPT_SCAN_VERBOSE) {
          console.log(
            `[${new Date().toISOString()}] Challenge ${challengeId} already present in wallet ${walletId} receipts.`
          );
        }
      } else {
        anyUnsolved = true;
        if (RECEIPT_SCAN_VERBOSE) {
          console.log(
            `[${new Date().toISOString()}] Challenge ${challengeId} not found in wallet ${walletId} receipts.`
          );
        }
      }
    }

    if (anyUnsolved) {
      const labelStart = sample[0];
      const labelEnd = sample[sample.length - 1];
      console.log(
        `[${new Date().toISOString()}] Unsolved wallets detected in range ${labelStart}-${labelEnd}; automation needed.`
      );
      return false; // proceed with automation
    }
  }

  // If we reach here, every checked wallet had the challenge — skip
  console.log(
    `[${new Date().toISOString()}] All sampled wallets have receipts for ${challengeId}; skipping automation.`
  );
  return true;
};

const createWalletBatches = async () => {
  const walletIds = await listWalletIds();
  if (walletIds.length === 0) return [];

  // Determine [startId, endId]
  const minId = walletIds[0];
  const maxId = walletIds[walletIds.length - 1];
  const reqStart = RAW_START !== undefined ? Number(RAW_START) : minId;
  const reqEnd = RAW_END !== undefined ? Number(RAW_END) : maxId;
  const startId = Math.max(minId, Math.min(maxId, reqStart));
  const endId = Math.max(startId, Math.min(maxId, reqEnd));

  // Restrict to selected range
  const selected = walletIds.filter((id) => id >= startId && id <= endId);
  if (selected.length === 0) return [];

  const effectiveBatchSize = BATCH_SIZE > 0 ? BATCH_SIZE : selected.length;

  // Map selected IDs to 1-based positions in the global ordered list
  const positions = selected.map((id) => walletIds.indexOf(id) + 1);

  const batches = [];
  for (let i = 0; i < positions.length; i += effectiveBatchSize) {
    const posStart = positions[i];
    const posEnd = positions[Math.min(i + effectiveBatchSize, positions.length) - 1];
    const labelStart = selected[i];
    const labelEnd = selected[Math.min(i + effectiveBatchSize, selected.length) - 1];
    batches.push({ posStart, posEnd, labelStart, labelEnd, total: selected.length });
  }

  return batches;
};

const runSolverBatch = (challengeHash, batch, token) => {
  if (token.cancelled) {
    console.log(
      `[${new Date().toISOString()}] Skipping automate-solver batch ${batch.labelStart}-${batch.labelEnd} for challenge ${challengeHash.slice(0, 12)} (cancelled)`
    );
    return Promise.resolve();
  }

  console.log(
    `[${new Date().toISOString()}] Starting automate-solver.js for wallets ${batch.labelStart}-${batch.labelEnd} (challenge ${challengeHash.slice(0, 12)})`
  );

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [SOLVER_SCRIPT, '--from', String(batch.posStart), '--to', String(batch.posEnd)], {
        cwd: ROOT_DIR,
        stdio: 'inherit'
      });
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Failed to spawn automate-solver for challenge ${challengeHash.slice(0, 12)} (wallets ${batch.labelStart}-${batch.labelEnd}):`,
        error
      );
      resolve();
      return;
    }

    activeSolverRuns.set(child, { challengeHash, startIndex: batch.posStart, endIndex: batch.posEnd });

    child.on('exit', (code, signal) => {
      activeSolverRuns.delete(child);
      const challengeSnippet = challengeHash.slice(0, 12);
      if (code === 0) {
        console.log(
          `[${new Date().toISOString()}] automate-solver batch ${batch.labelStart}-${batch.labelEnd} for challenge ${challengeSnippet} completed successfully`
        );
      } else {
        const exitDescription =
          code === null
            ? `terminated${signal ? ` by signal ${signal}` : ''}`
            : `exited with code ${code}${signal ? ` (signal ${signal})` : ''}`;
        console.warn(
          `[${new Date().toISOString()}] automate-solver batch ${batch.labelStart}-${batch.labelEnd} for challenge ${challengeSnippet} ${exitDescription}`
        );
      }
      resolve();
    });

    child.on('error', (error) => {
      activeSolverRuns.delete(child);
      try {
        console.error(
          `[${new Date().toISOString()}] Failed during automate-solver batch ${batch.labelStart}-${batch.labelEnd} for challenge ${challengeHash.slice(0, 12)}:`,
          error
        );
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Failed during automate-solver batch for challenge:`, error);
      }
      resolve();
    });
  });
};

const runBatchesForChallenge = async (challengeHash, token) => {
  const batches = await createWalletBatches();
  const challengeSnippet = challengeHash.slice(0, 12);

  if (batches.length === 0) {
    console.warn(
      `[${new Date().toISOString()}] No wallet batches to process for challenge ${challengeSnippet}. Check data dir '${DATA_FINAL_DIR}'.`
    );
    return;
  }

  const totalSelected = batches[0]?.total ?? 0;
  const maxPerBatch = BATCH_SIZE > 0 ? BATCH_SIZE : totalSelected;
  console.log(
    `[${new Date().toISOString()}] Processing ${batches.length} automate-solver batch(es) of up to ${maxPerBatch} wallet(s) for challenge ${challengeSnippet}`
  );

  for (const batch of batches) {
    if (token.cancelled) {
      console.log(
        `[${new Date().toISOString()}] Batch execution cancelled before starting wallets ${batch.labelStart}-${batch.labelEnd} for challenge ${challengeSnippet}`
      );
      break;
    }

    await runSolverBatch(challengeHash, batch, token);

    if (token.cancelled) {
      console.log(
        `[${new Date().toISOString()}] Batch execution cancelled after wallets ${batch.labelStart}-${batch.labelEnd} for challenge ${challengeSnippet}`
      );
      break;
    }
  }

  if (!token.cancelled) {
    console.log(
      `[${new Date().toISOString()}] Completed automate-solver batches for challenge ${challengeSnippet}`
    );
  } else {
    console.log(
      `[${new Date().toISOString()}] Automate-solver batches for challenge ${challengeSnippet} cancelled before completion`
    );
  }
};

const ensureOutputDir = async () => {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
};

const hashResponse = (body) => crypto.createHash('sha256').update(body).digest('hex');

// Find the latest local challenge file (DD-CC.json) and return { key, path, payload }
async function findLatestLocalChallenge() {
  try {
    const entries = await fs.readdir(OUTPUT_DIR, { withFileTypes: true });
    const keys = entries
      .filter(e => e.isFile() && /^(\d{2})-(\d{2})\.json$/.test(e.name))
      .map(e => e.name.replace(/\.json$/, ''))
      .sort();
    if (keys.length === 0) return null;
    const key = keys[keys.length - 1];
    const filePath = path.join(OUTPUT_DIR, `${key}.json`);
    const text = await fs.readFile(filePath, 'utf8');
    let payload;
    try { const parsed = JSON.parse(text); payload = parsed?.challenge ?? parsed; } catch { payload = null; }
    return { key, path: filePath, payload };
  } catch {
    return null;
  }
}

// Try to continue work with last-known challenge when API is unavailable
async function resumeWithLastKnown(lastChallengePath, lastChallengeKey) {
  try {
    if (!lastChallengePath || !lastChallengeKey) {
      const local = await findLatestLocalChallenge();
      if (!local) return;
      lastChallengePath = local.path;
      lastChallengeKey = local.key;
    }

    // Load challenge payload to check receipt status
    let chPayload = null;
    try {
      const text = await fs.readFile(lastChallengePath, 'utf8');
      const parsed = JSON.parse(text);
      chPayload = parsed?.challenge ?? parsed;
    } catch {}

    // Check if all wallets have confirmed receipts for the last challenge
    let allConfirmed = false;
    if (chPayload) {
      try {
        allConfirmed = await allWalletsHaveConfirmedReceipts(chPayload);
        if (allConfirmed) {
          console.log(`[${new Date().toISOString()}] All wallets have confirmed receipts for challenge ${lastChallengeKey}; skipping backlog submission.`);
        }
      } catch (e) {
        // If check fails, proceed with backlog submission
      }
    }

    // Only submit backlog if not all solutions are confirmed
    if (!allConfirmed) {
      // Attempt backlog for previous DD-CC if not processed
      try { await submitBacklogForPreviousIfAvailable(lastChallengeKey); } catch {}
    }

    // Decide if we should (re)run automation using last-known payload
    try {
      if (chPayload) {
        const needRun = !(await isChallengePresentInSampleReceipts(chPayload));
        if (needRun && activeSolverRuns.size === 0 && currentBatchToken === null) {
          console.log(`[${new Date().toISOString()}] API unavailable; resuming batches for last-known challenge ${lastChallengeKey}.`);
          startAutomateSolverForChallenge(lastChallengeKey);
        }
      }
    } catch (e) {
      // If inspection fails, still try to (re)start if idle
      if (activeSolverRuns.size === 0 && currentBatchToken === null) {
        console.log(`[${new Date().toISOString()}] API unavailable; resuming batches for last-known challenge ${lastChallengeKey}.`);
        startAutomateSolverForChallenge(lastChallengeKey);
      }
    }
  } catch {}
}

// Wait for the currently running automate-solver batch (if any) to finish.
// Returns 'none' if no active run, 'exit' on normal exit, 'error' on error event,
// or 'timeout' if SOFT_ROTATE_TIMEOUT_MS elapsed.
const waitForActiveSolverToFinish = async (timeoutMs = SOFT_ROTATE_TIMEOUT_MS) => {
  if (activeSolverRuns.size === 0) return 'none';
  const waits = [];
  for (const [child] of activeSolverRuns.entries()) {
    waits.push(new Promise((resolve) => {
      child.once('exit', () => resolve('exit'));
      child.once('error', () => resolve('error'));
    }));
  }
  const waiter = Promise.race(waits);
  if (!timeoutMs || timeoutMs <= 0) return await waiter;
  return await withTimeout(waiter, timeoutMs);
};

const writeChallengeFile = async (challenge) => {
  // Prefer naming as DD-CC.json derived from challenge_id like "**D02C01"
  const id = challenge?.challenge_id ?? challenge?.challengeId ?? '';
  const dayNum = challenge?.day ?? null;
  const chNum = challenge?.challenge_number ?? null;

  // Extract DD and CC from challenge_id when possible
  let dd = null;
  let cc = null;
  const m = typeof id === 'string' ? id.match(/D(\d{2})C(\d{2})$/) : null;
  if (m) {
    dd = m[1];
    cc = m[2];
  }
  // Fallback: use numeric day/challenge_number with zero padding
  if (!dd && Number.isFinite(Number(dayNum))) {
    dd = String(Math.max(0, Number(dayNum))).padStart(2, '0');
  }
  if (!cc && Number.isFinite(Number(chNum))) {
    cc = String(Math.max(0, Number(chNum))).padStart(2, '0');
  }

  const baseName = dd && cc
    ? `${dd}-${cc}`
    : (chNum !== null && chNum !== undefined
        ? String(chNum)
        : new Date().toISOString().replace(/[:.]/g, '-'));

  const filePath = path.join(OUTPUT_DIR, `${baseName}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(challenge, null, 2)}\n`, 'utf8');
  console.log(`Saved new challenge to ${path.relative(process.cwd(), filePath)}`);
  return filePath;
};

// Run a submit-only pass for an explicit (previous) challenge file path
const runSubmitBacklogForChallenge = async (challengePath) => {
  const batches = await createWalletBatches();
  if (!challengePath || batches.length === 0) return;
  const label = path.basename(challengePath);
  const totalSelected = batches[0]?.total ?? 0;
  const maxPerBatch = BATCH_SIZE > 0 ? BATCH_SIZE : totalSelected;
  console.log(
    `[${new Date().toISOString()}] Submitting backlog solutions for ${label} in ${batches.length} batch(es) of up to ${maxPerBatch} wallet(s)`
  );

  for (const batch of batches) {
    console.log(
      `[${new Date().toISOString()}] Backlog submit for wallets ${batch.labelStart}-${batch.labelEnd} (challenge ${label})`
    );
    await new Promise((resolve) => {
      let child;
      try {
        child = spawn(process.execPath,
          [
            SOLVER_SCRIPT,
            '--from', String(batch.posStart),
            '--to', String(batch.posEnd),
            '--challenge', challengePath,
          ],
          { cwd: ROOT_DIR, stdio: 'inherit', env: { ...process.env, AUTOMATE_SUBMIT_ONLY: '1' } }
        );
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] Failed to spawn backlog submit for ${label} (wallets ${batch.labelStart}-${batch.labelEnd}):`, error
        );
        resolve();
        return;
      }
      child.on('exit', () => resolve());
      child.on('error', () => resolve());
    });
  }
};

const startAutomateSolverForChallenge = (challengeKey) => {
  const token = { cancelled: false };
  currentBatchToken = token;

  (async () => {
    try {
      await runBatchesForChallenge(challengeKey, token);
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Unexpected error while processing automate-solver batches for challenge ${String(challengeKey).slice(0, 12)}:`,
        error
      );
    } finally {
      if (currentBatchToken === token) {
        currentBatchToken = null;
      }
    }
  })();
};

// Track processed backlog keys in this process to avoid repeating work
const processedBacklogKeys = new Set();

const submitBacklogForPreviousIfAvailable = async (currentKey) => {
  try {
    const entries = await fs.readdir(OUTPUT_DIR, { withFileTypes: true });
    const keys = entries
      .filter(e => e.isFile() && /^(\d{2})-(\d{2})\.json$/.test(e.name))
      .map(e => e.name.replace(/\.json$/, ''))
      .sort();
    if (keys.length < 2) return;
    const prevKey = keys[keys.length - 2];
    if (prevKey === currentKey) return;
    if (processedBacklogKeys.has(prevKey)) return;
    const prevPath = path.join(OUTPUT_DIR, `${prevKey}.json`);
    processedBacklogKeys.add(prevKey);
    // Run in background, no await to avoid blocking
    fastSubmitBacklogForChallenge(prevPath).catch(() => {});
  } catch {}
};

const fetchChallenge = async () => {
  const requestMetadata = {
    url: CHALLENGE_URL,
    method: 'GET',
    headers: REQUEST_HEADERS,
    timestamp: new Date().toISOString()
  };

  const response = await fetch(CHALLENGE_URL, {
    method: 'GET',
    headers: REQUEST_HEADERS
  });

  const text = await response.text();
  let jsonBody;
  try {
    jsonBody = JSON.parse(text);
  } catch {
    jsonBody = text;
  }

  return {
    requestMetadata,
    status: response.status,
    body: jsonBody,
    rawBody: text
  };
};

// Fast backlog submitter: submit unsent solutions for a given (previous) challenge
// using filename pattern solution_DD-CC_<nonce>.json to avoid JSON reads.
// This drastically reduces I/O vs. spawning automate-solver.js.
const fastSubmitBacklogForChallenge = async (challengePath) => {
  try {
    const content = await fs.readFile(challengePath, 'utf8');
    const payload = JSON.parse(content);
    const ch = payload?.challenge ?? payload;
    const challengeId = ch?.challenge_id ?? ch?.challengeId;
    const day = Number(ch?.day ?? NaN);
    const num = Number(ch?.challenge_number ?? NaN);
    if (!challengeId || !Number.isFinite(day) || !Number.isFinite(num)) {
      console.warn(`[${new Date().toISOString()}] fastSubmitBacklog: insufficient challenge fields; skipping fast path.`);
      return await runSubmitBacklogForChallenge(challengePath); // fallback
    }

    const dd = String(Math.max(0, day)).padStart(2, '0');
    const cc = String(Math.max(0, num)).padStart(2, '0');
    const key = `${dd}-${cc}`;
    const solutionsDir = PATHS.solutionsRoot;

    // Build wallet list with addresses
    const walletIds = await listWalletIds();
    if (walletIds.length === 0) return;

    const concurrency = Number(process.env.FAST_SUBMIT_CONCURRENCY ?? 16);
    const queue = [];
    let active = 0;
    let totalCandidates = 0;
    let totalSubmitted = 0;

    const runTask = () => new Promise((resolve) => {
      const next = async () => {
        const task = queue.shift();
        if (!task) return resolve();
        active++;
        try { const ok = await task(); if (ok) totalSubmitted++; } catch { /* ignore */ }
        active--;
        if (queue.length > 0) {
          await next();
        } else if (active === 0) {
          resolve();
        }
      };
      next();
    });

    const submitOne = async (address, walletFolder, nonce, submittedSaltsSet) => {
      const url = `${SUBMIT_URL_BASE}/${address}/${challengeId}/${nonce}`;
      try {
        const res = await fetch(url, { method: 'POST', headers: REQUEST_HEADERS, body: JSON.stringify({}) });
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch { body = { raw: text }; }
        if (!res.ok) return false; // let later passes retry

        // Update receipt
        const receiptPath = getReceiptFilePath(walletFolder);
        let receipts = [];
        try { receipts = JSON.parse(await fs.readFile(receiptPath, 'utf8')); } catch {}
        const submittedAtValue = body.submittedAt || body.submitted_at || new Date().toISOString();
        const cryptoReceiptData = body.crypto_receipt || body.cryptoReceipt || {};
        const record = {
          challengeId,
          challengeNumber: num,
          challengeTotal: ch.challenge_total || ch.total_challenges || 504,
          campaignDay: day,
          difficulty: ch.difficulty,
          status: body.status || 'submitted',
          noPreMine: ch.no_pre_mine || ch.noPreMine,
          noPreMineHour: ch.no_pre_mine_hour || ch.noPreMineHour,
          latestSubmission: ch.latest_submission || ch.latestSubmission,
          availableAt: ch.issued_at || ch.availableAt || ch.issuedAt,
          acceptedAt: body.acceptedAt || body.accepted_at || cryptoReceiptData.timestamp || submittedAtValue,
          solvedAt: body.solvedAt || body.solved_at || cryptoReceiptData.timestamp || submittedAtValue,
          validatedAt: body.status === 'validated' ? (body.validatedAt || body.validated_at || submittedAtValue) : null,
          submittedAt: submittedAtValue,
          salt: String(nonce).toLowerCase(),
          hash: body.hash || null,
          cryptoReceipt: {
            preimage: cryptoReceiptData.preimage || null,
            timestamp: cryptoReceiptData.timestamp || new Date().toISOString(),
            signature: cryptoReceiptData.signature || null,
          },
        };
        const idx = Array.isArray(receipts) ? receipts.findIndex(r => r.challengeId === challengeId && String(r.salt).toLowerCase() === record.salt) : -1;
        if (idx >= 0) receipts[idx] = record; else receipts.push(record);
        await saveReceipts(walletFolder, receipts);
        // Update in-memory set to avoid duplicate submissions within this pass
        try { submittedSaltsSet && submittedSaltsSet.add(String(nonce).toLowerCase()); } catch {}
        return true;
      } catch {
        return false;
      }
    };

    const filenameTupleRe = new RegExp(`^solution_${dd}-${cc}_([0-9a-fA-F]{16})\\.json$`);

    for (const walletId of walletIds) {
      const walletDir = path.join(DATA_FINAL_DIR, String(walletId));
      const walletFile = path.join(walletDir, 'wallet.json');
      let address = null;
      try {
        const walletData = JSON.parse(await fs.readFile(walletFile, 'utf8'));
        address = walletData?.wallet?.addresses?.external?.[0]?.paymentAddress || null;
      } catch {}
      if (!address) continue;

      // Load existing salts for this challenge for this wallet to avoid resubmission
      let receipts = [];
      try { receipts = await loadReceipts(String(walletId)); } catch {}
      const submittedSalts = new Set(
        (Array.isArray(receipts) ? receipts : [])
          .filter(r => r && r.challengeId === challengeId)
          .map(r => String(r.salt).toLowerCase())
      );

      const addressDir = path.join(solutionsDir, address);
      let files;
      try { files = await fs.readdir(addressDir); } catch { files = []; }
      for (const base of files) {
        const m = base.match(filenameTupleRe);
        if (!m) continue;
        const nonce = (m[1] || '').toLowerCase();
        if (submittedSalts.has(nonce)) continue;
        // queue submission task
        totalCandidates++;
        queue.push(() => submitOne(address, String(walletId), nonce, submittedSalts));
      }
    }

    // Run queued tasks with bounded concurrency
    const runners = [];
    for (let i = 0; i < Math.max(1, concurrency); i++) runners.push(runTask());
    await Promise.allSettled(runners);

    console.log(
      `[${new Date().toISOString()}] Fast backlog submit for ${key}: candidates=${totalCandidates}, submitted=${totalSubmitted}`
    );
    processedBacklogKeys.add(key);
  } catch (e) {
    console.warn(`[${new Date().toISOString()}] fastSubmitBacklog failed: ${e.message}`);
    return await runSubmitBacklogForChallenge(challengePath);
  }
};

const main = async () => {
  await ensureOutputDir();
  const seenKeys = new Set();
  let lastChallengePath = null;
  let lastChallengeKey = null;
  let lastContentHash = null;

  // On startup, check receipts for the last available challenge
  try {
    const local = await findLatestLocalChallenge();
    if (local && local.payload) {
      const allConfirmed = await allWalletsHaveConfirmedReceipts(local.payload);
      if (allConfirmed) {
        console.log(`[${new Date().toISOString()}] Startup check: All wallets have confirmed receipts for last challenge ${local.key}.`);
      } else {
        console.log(`[${new Date().toISOString()}] Startup check: Some wallets are missing confirmed receipts for last challenge ${local.key}.`);
      }
      // Initialize last known challenge from local file
      lastChallengePath = local.path;
      lastChallengeKey = local.key;
      try {
        const text = await fs.readFile(local.path, 'utf8');
        lastContentHash = hashResponse(text);
      } catch {}
    }
  } catch (e) {
    console.warn(`[${new Date().toISOString()}] Startup receipt check failed: ${e.message}`);
  }

  console.log(`Polling ${CHALLENGE_URL} every ${POLL_INTERVAL_MS}ms. Press Ctrl+C to stop.`);

  while (true) {
    try {
      const result = await fetchChallenge();
      const { body, rawBody, requestMetadata, status } = result;
      const challengePayload = body?.challenge;
      if (!challengePayload) {
        console.log(
          `[${new Date().toISOString()}] Challenge endpoint returned no challenge object (status ${status}).`
        );
        // Continue with last-known challenge if available (keep submitting and/or mining)
        await resumeWithLastKnown(lastChallengePath, lastChallengeKey);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      // Compute stable key (DD-CC) for identity
      const key = getChallengeKey(challengePayload);
      if (!key) {
        // If we cannot form a key, fall back to previous behavior based on raw hash
        const hash = hashResponse(rawBody);
        if (!seenKeys.has(hash)) seenKeys.add(hash);
        console.log(`[${new Date().toISOString()}] Challenge key missing; skipping change detection.`);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const contentHash = hashResponse(rawBody);
      // Write/update challenge file only if content actually changed for the same key
      let newPath = lastChallengePath;
      if (lastChallengeKey !== key || contentHash !== lastContentHash) {
        newPath = await writeChallengeFile(challengePayload);
        // Update content hash snapshot when we actually write
        lastContentHash = contentHash;
      }
      if (lastChallengeKey === null) {
        // First observation in this run
        lastChallengeKey = key;
        lastChallengePath = newPath;
        lastContentHash = contentHash;
        // Also attempt backlog for previous DD-CC if present
        submitBacklogForPreviousIfAvailable(key).catch(() => {});
        const needRun = !(await isChallengePresentInSampleReceipts(challengePayload));
        if (needRun) {
          startAutomateSolverForChallenge(key);
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      if (key !== lastChallengeKey) {
        // True rotation to a new challenge: finish current batch, then start new batches
        const prevPath = lastChallengePath;
        const prevKey = lastChallengeKey;
        lastChallengeKey = key;
        lastChallengePath = newPath;
        lastContentHash = contentHash;

        // Soft rotation: cancel scheduling new batches and wait for the in-flight one to finish
        console.log(`[${new Date().toISOString()}] New challenge detected (DD-CC=${key}). Finishing current batch before starting new solve...`);
        cancelCurrentBatchSequence();
        const waitResult = await waitForActiveSolverToFinish();
        if (waitResult === 'timeout') {
          console.warn(`[${new Date().toISOString()}] Wait for current batch timed out after ${SOFT_ROTATE_TIMEOUT_MS}ms; proceeding to new solve.`);
        }
        // Safety: flush any leftover solutions from previous challenge quickly (non-blocking)
        if (prevPath) {
          fastSubmitBacklogForChallenge(prevPath).catch(() => {});
        }
        // Start new challenge solving
        console.log(`[${new Date().toISOString()}] Starting solve batches for new challenge DD-CC=${key}.`);
        startAutomateSolverForChallenge(key);
      } else {
        console.log(`[${new Date().toISOString()}] Challenge unchanged (DD-CC=${key}, status ${status}).`);
        // For unchanged key (even if body changed), do NOT stop workers. Optionally rerun automation if none active and sample shows need.
        try {
          // Also attempt backlog for immediate previous challenge if not processed yet
          submitBacklogForPreviousIfAvailable(key).catch(() => {});
          const needRun = !(await isChallengePresentInSampleReceipts(challengePayload));
          if (needRun && activeSolverRuns.size === 0 && currentBatchToken === null) {
            console.log(`[${new Date().toISOString()}] Unsolved wallets remain; re-running automation.`);
            startAutomateSolverForChallenge(key);
          }
        } catch (e) {
          console.warn(`[${new Date().toISOString()}] Retry-check failed: ${e.message}`);
        }
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Challenge fetch failed:`, error);
      // Network/HTTP error: continue with last-known challenge if available
      try { await resumeWithLastKnown(lastChallengePath, lastChallengeKey); } catch {}
    }

    await sleep(POLL_INTERVAL_MS);
  }
};

export const startPoller = async (options = {}) => {
  const cliArgs = options.args ?? parseArgs();
  RAW_START = options.startIndex ?? cliArgs.startIndex ?? process.env.AUTOMATE_SOLVER_START_INDEX;
  RAW_END = options.endIndex ?? cliArgs.endIndex ?? process.env.AUTOMATE_SOLVER_END_INDEX;
  RAW_BATCH = options.batchSize ?? cliArgs.batchSize ?? process.env.AUTOMATE_SOLVER_BATCH_SIZE;
  BATCH_SIZE =
    RAW_BATCH !== undefined && RAW_BATCH !== null ? Number(RAW_BATCH) : DEFAULT_BATCH_SIZE;
  if (!Number.isFinite(BATCH_SIZE) || BATCH_SIZE <= 0) {
    BATCH_SIZE = DEFAULT_BATCH_SIZE;
  }

  await main();
};

if (process.argv[1] && process.argv[1].endsWith('poll.js')) {
  startPoller().catch((error) => {
    console.error('Unexpected error:', error);
    process.exitCode = 1;
  });
}

const withTimeout = (p, ms) => {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      resolve('timeout');
    }, Math.max(0, ms|0));
    p.then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } })
     .catch((e) => { if (!done) { done = true; clearTimeout(t); resolve('error'); } });
  });
};
