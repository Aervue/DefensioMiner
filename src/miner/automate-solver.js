#!/usr/bin/env node
/**
 * Automation script that:
 * 1. Scans data_final folders for wallet addresses
 * 2. Gets the current challenge
 * 3. Runs solver.rs for each wallet
 * 4. Saves solutions in solution/{challenge-name}/ directory per wallet
 * 5. Submits solutions and saves receipts
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePaths, apiEndpoints } from '../config/index.js';

const execAsync = promisify(exec);
const PATHS = resolvePaths();
const ROOT_DIR = PATHS.projectRoot;
const SOLVER_ROOT = path.join(ROOT_DIR, 'solver');

// Wallet data directory
const DATA_FINAL_DIR = PATHS.miningRoot;
const CHALLENGES_DIR = PATHS.challengeCache;
const SOLUTIONS_BASE_DIR = PATHS.solutionsRoot;
// Receipts are now per-wallet: data_final/{wallet_folder}/challenge_receipt.json

const DEFAULT_DIAGNOSTICS_BASE_URL = 'http://127.0.0.1:3000/api/diagnostics';
const DIAGNOSTICS_BASE_URL = (() => {
  const raw = process.env.DIAGNOSTICS_BASE_URL ?? DEFAULT_DIAGNOSTICS_BASE_URL;
  return typeof raw === 'string' ? raw.replace(/\/$/, '') : DEFAULT_DIAGNOSTICS_BASE_URL;
})();
const DIAGNOSTICS_ENABLED = process.env.DIAGNOSTICS_ENABLED !== '0';
const SOURCE_SERVER_IP = process.env.SOURCE_SERVER_IP ?? process.env.DIAGNOSTICS_SOURCE_IP ?? null;

function resolveSourceServerIp() {
  if (SOURCE_SERVER_IP && SOURCE_SERVER_IP.trim().length > 0) {
    return SOURCE_SERVER_IP.trim();
  }

  const interfaces = os.networkInterfaces();
  for (const ifaceRecords of Object.values(interfaces)) {
    for (const record of ifaceRecords ?? []) {
      if (!record) continue;
      const family = typeof record.family === 'string' ? record.family : record.family?.toString();
      if ((family === 'IPv4' || family === '4') && !record.internal && record.address) {
        return record.address;
      }
    }
  }

  return null;
}

const toFiniteNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const buildDiagnosticsPayload = (report, challengeData, timestampSeconds) => {
  if (!report?.results) {
    return null;
  }

  const success = toFiniteNumber(report.results.success, 0);
  if (success <= 0) {
    return null;
  }

  const skipped = toFiniteNumber(report.results.skipped, 0);
  const failed = toFiniteNumber(report.results.failed, 0);
  const generationMs = toFiniteNumber(report.timings?.generationMs, 0);
  const submissionMs = toFiniteNumber(report.timings?.submissionMs, 0);

  const challengeId =
    challengeData?.challenge_id ??
    challengeData?.challengeId ??
    (Number.isFinite(Number(challengeData?.challenge_number))
      ? `challenge-${Number(challengeData.challenge_number)}`
      : null);

  return {
    solutions: {
      succeded: success,
      skipped,
      failed,
    },
    currentChallenge: challengeId ?? 'unknown',
    timeSpentGeneration: generationMs,
    timeSpentSubmission: submissionMs,
    timeStamp: toFiniteNumber(timestampSeconds, Math.floor(Date.now() / 1000)),
    dataDir: process.env.ASHMAIZE_DATA_DIR ?? DATA_FINAL_DIR,
  };
};

async function sendDiagnosticsReport(report, challengeData, timestampSeconds) {
  if (!DIAGNOSTICS_ENABLED) {
    return false;
  }

  const payload = buildDiagnosticsPayload(report, challengeData, timestampSeconds);
  if (!payload) {
    console.log(
      `[${new Date().toISOString()}] Diagnostics POST skipped: no successful solutions to report.`
    );
    return false;
  }

  const sourceIp = resolveSourceServerIp();
  if (!sourceIp) {
    console.warn(
      `[${new Date().toISOString()}] Unable to determine source server IP; skipping diagnostics POST.`
    );
    return false;
  }

  const url = `${DIAGNOSTICS_BASE_URL}/${encodeURIComponent(sourceIp)}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let responseText = '';
      try {
        responseText = await response.text();
      } catch {
        // Ignore extraction failures
      }

      console.warn(
        `[${new Date().toISOString()}] Diagnostics POST failed (${response.status} ${response.statusText}): ${responseText}`
      );
      return false;
    }

    console.log(
      `[${new Date().toISOString()}] Diagnostics POST succeeded (${response.status}) to ${url}`
    );
    return true;
  } catch (error) {
    console.warn(`[${new Date().toISOString()}] Diagnostics POST error: ${error.message}`);
    return false;
  }
}

async function isElfExecutable(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    if (bytesRead !== 4) {
      return false;
    }
    return buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46;
  } catch {
    return false;
  } finally {
    if (handle) {
      await handle.close();
    }
  }
}

// Try to find solver binary (prefer release, fallback to debug)
async function findSolverBinary(binaryName = 'solve') {
  const releaseBin = path.join(SOLVER_ROOT, 'target', 'release', binaryName);
  const debugBin = path.join(SOLVER_ROOT, 'target', 'debug', binaryName);

  try {
    await fs.access(releaseBin);
    if (await isElfExecutable(releaseBin)) {
      return releaseBin;
    }
    console.warn(`Warning: Release binary '${releaseBin}' is not a Linux ELF executable. Trying debug build...`);
  } catch {
    // Ignore and try debug build
  }

  try {
    await fs.access(debugBin);
    if (await isElfExecutable(debugBin)) {
      console.warn(`Warning: Using debug build instead of release build`);
      return debugBin;
    }
    console.warn(`Warning: Debug binary '${debugBin}' is not a Linux ELF executable.`);
  } catch {
    // Fall through to error
  }

  console.warn(`Falling back to running '${binaryName}' via cargo. This may trigger a compilation step.`);
  return `cargo run --release --bin ${binaryName} --`;
}

const SUBMIT_URL_BASE = apiEndpoints.solution();
const REQUEST_HEADERS = {
  'sec-fetch-user': '?1',
  'sec-ch-ua-platform': '"Windows"',
  referer: 'https://mine.defensio.io/wizard/mine',
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
  'content-type': 'application/json',
};

/**
 * Get all wallet addresses from data_final folder
 */
async function getWalletAddresses() {
  const wallets = [];
  const entries = await fs.readdir(DATA_FINAL_DIR, { withFileTypes: true });

  // Filter directories and sort numerically
  const dirs = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => {
      const numA = parseInt(a, 10);
      const numB = parseInt(b, 10);
      if (isNaN(numA) || isNaN(numB)) {
        return a.localeCompare(b); // Fallback to string comparison for non-numeric
      }
      return numA - numB;
    });

  const seenAddresses = new Set();
  for (const dirName of dirs) {
    const walletDir = path.join(DATA_FINAL_DIR, dirName);
    const walletFile = path.join(walletDir, 'wallet.json');

    try {
      const walletData = JSON.parse(await fs.readFile(walletFile, 'utf8'));
      const addresses = walletData?.wallet?.addresses;

      if (addresses?.external && addresses.external.length > 0) {
        const externalAddress = addresses.external[0].paymentAddress;
        if (externalAddress) {
          if (seenAddresses.has(externalAddress)) {
            console.warn(`Duplicate wallet address detected; skipping folder ${dirName} (address already queued)`);
          } else {
            seenAddresses.add(externalAddress);
            wallets.push({
              folder: dirName,
              address: externalAddress,
              walletData,
            });
          }
        }
      }
    } catch (err) {
      console.warn(`Failed to read wallet from ${walletFile}:`, err.message);
    }
  }

  return wallets;
}

/**
 * Get the latest challenge from challanges directory
 */
async function getCurrentChallenge() {
  const entries = await fs.readdir(CHALLENGES_DIR, { withFileTypes: true });
  const challengeFiles = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

    const filePath = path.join(CHALLENGES_DIR, entry.name);
    try {
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const challenge = data.challenge || data;
      const challengeNumber = Number(challenge.challenge_number);
      const campaignDay = Number(challenge.day);

      // Composite ordering: day first, then challenge number
      const orderKey = (Number.isFinite(campaignDay) ? campaignDay : 0) * 100 + (Number.isFinite(challengeNumber) ? challengeNumber : 0);

      challengeFiles.push({
        number: challengeNumber,
        day: campaignDay,
        orderKey,
        path: filePath,
        challenge,
      });
    } catch (err) {
      console.warn(`Failed to read challenge ${filePath}:`, err.message);
    }
  }

  if (challengeFiles.length === 0) {
    throw new Error('No challenges found in challanges directory');
  }

  // Sort by day then number descending and get the latest
  challengeFiles.sort((a, b) => b.orderKey - a.orderKey);
  return challengeFiles[0];
}

/**
 * Run solver for a single wallet
 */
async function runSolver(solverBin, walletAddress, challengePath, suffixOffset = null) {
  let command = `${solverBin} --address "${walletAddress}" "${challengePath}"`;
  
  const env = { ...process.env, WALLET_ADDRESS: walletAddress };
  
  // If suffixOffset is provided, set it in environment to start from a different point
  if (suffixOffset !== null) {
    env.ASHMAIZE_SUFFIX_OFFSET = suffixOffset.toString();
  }
  
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: SOLVER_ROOT,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      env: env
    });

    if (stderr && !stderr.includes('Building ROM')) {
      console.error(`Solver stderr for ${walletAddress.substring(0, 20)}...:`, stderr);
    }

    // Extract solution file path from stdout (last line should be the path)
    const lines = stdout.trim().split('\n').filter(l => l.trim());
    const solutionPath = lines[lines.length - 1]?.trim();
    
    return { success: true, solutionPath, stdout, stderr };
  } catch (error) {
    console.error(`Solver failed for ${walletAddress.substring(0, 20)}...:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Get solution files for a wallet filtered to current challenge.
 * Solutions are stored in: solutions/{wallet_address}/solution_*.json
 * Matching is by challenge_id when available, otherwise by (day, challenge_number).
 */
async function getSolutionFiles(challengeMeta, walletAddress) {
  const walletDir = path.join(SOLUTIONS_BASE_DIR, String(walletAddress));
  
  try {
    const files = await fs.readdir(walletDir);
    const solutionFiles = files
      .filter((f) => f.startsWith('solution_') && f.endsWith('.json'))
      .map((f) => path.join(walletDir, f))
      .sort();

    const matchingSolutions = [];
    const wantId = challengeMeta?.id || challengeMeta?.challenge_id || null;
    const wantDay = challengeMeta?.day !== undefined ? Number(challengeMeta.day) : null;
    const wantNum = challengeMeta?.number !== undefined ? Number(challengeMeta.number) : (challengeMeta?.challenge_number !== undefined ? Number(challengeMeta.challenge_number) : null);
    const filenameTupleRe = /^solution_(\d{2})-(\d{2})_([0-9a-fA-F]{16})\.json$/;
    for (const file of solutionFiles) {
      const base = path.basename(file);
      // Fast path: filename contains DD-CC and nonce; avoid reading JSON entirely
      const fm = base.match(filenameTupleRe);
      if (fm && Number.isFinite(wantDay) && Number.isFinite(wantNum)) {
        const dd = Number(fm[1]);
        const cc = Number(fm[2]);
        if (dd === wantDay && cc === wantNum) {
          const nonce = String(fm[3]).toLowerCase();
          matchingSolutions.push({ file, nonce });
          continue;
        }
      }

      // Fallback path: read JSON and match by challenge id or (day, number)
      try {
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        const solChallenge = data.challenge || data;
        const fileId = solChallenge.challenge_id || solChallenge.challengeId || null;
        const fileDay = solChallenge.day !== undefined ? Number(solChallenge.day) : null;
        const fileNum = solChallenge.challenge_number !== undefined ? Number(solChallenge.challenge_number) : null;

        const idMatches = wantId && fileId && String(wantId) === String(fileId);
        const tupleMatches = Number.isFinite(wantDay) && Number.isFinite(wantNum) && Number.isFinite(fileDay) && Number.isFinite(fileNum)
          ? (wantDay === fileDay && wantNum === fileNum)
          : false;

        if (idMatches || (!wantId && tupleMatches)) {
          matchingSolutions.push({ file, solution: data });
        }
      } catch (err) {
        console.warn(`Failed to read solution ${file}:`, err.message);
      }
    }

    return matchingSolutions;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

/**
 * Run batch solver to generate solutions for all wallets
 */
async function runBatchSolver(solverBin, walletAddresses, challengePath, solutionsDir) {
  // Create temporary file with addresses
  const tempFile = path.join(SOLVER_ROOT, `.batch_addresses_${Date.now()}.txt`);
  try {
    await fs.writeFile(tempFile, walletAddresses.join('\n') + '\n', 'utf8');
    
    const command = `${solverBin} --addresses "${tempFile}" --solutions-dir "${solutionsDir}" "${challengePath}"`;
    console.log(`Running batch solver for ${walletAddresses.length} wallet(s)...`);

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: SOLVER_ROOT,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      });

      if (stderr && !stderr.includes('Building ROM') && !stderr.includes('Using cached ROM')) {
        console.error(`Batch solver stderr:`, stderr);
      }

      return { success: true, stdout, stderr };
    } catch (error) {
      console.error(`Batch solver failed:`, error.message);
      return { success: false, error: error.message };
    } finally {
      // Clean up temp file
      try {
        await fs.unlink(tempFile);
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  } catch (error) {
    console.error(`Failed to create addresses file:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Submit a solution
 */
async function submitSolution(address, challengeId, nonce) {
  const url = `${SUBMIT_URL_BASE}/${address}/${challengeId}/${nonce}`;
  console.log(`Submitting: POST ${url}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: REQUEST_HEADERS,
      body: JSON.stringify({}),
    });

    const text = await response.text();
    let jsonBody;
    try {
      jsonBody = JSON.parse(text);
    } catch {
      jsonBody = { raw: text };
    }

    // If response is successful, the body should contain the receipt data
    if (response.ok && jsonBody) {
      return {
        success: true,
        status: response.status,
        statusText: response.statusText,
        receipt: jsonBody,
        rawBody: text,
      };
    }

    const retryable = response.status === 429 || response.status >= 500;
    const retryAfter = response.headers?.get?.('retry-after') ?? null;
    return {
      success: false,
      status: response.status,
      statusText: response.statusText,
      body: jsonBody,
      rawBody: text,
      retryable,
      retryAfter,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      retryable: true,
    };
  }
}

/**
 * Get receipt file path for a wallet
 */
function getReceiptFilePath(walletFolder) {
  return path.join(DATA_FINAL_DIR, walletFolder, 'challenge_receipt.json');
}

/**
 * Load or create receipts file for a wallet
 */
async function loadReceipts(walletFolder) {
  const receiptFile = getReceiptFilePath(walletFolder);
  try {
    const data = await fs.readFile(receiptFile, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

/**
 * Save receipts file for a wallet
 */
async function saveReceipts(walletFolder, receipts) {
  const receiptFile = getReceiptFilePath(walletFolder);
  // Ensure the directory exists
  const receiptDir = path.dirname(receiptFile);
  await fs.mkdir(receiptDir, { recursive: true });
  await fs.writeFile(receiptFile, JSON.stringify(receipts, null, 2) + '\n', 'utf8');
}

/**
 * Check if challenge is already solved for a wallet
 */
function isChallengeSolved(receipts, challengeId) {
  if (!Array.isArray(receipts) || receipts.length === 0) return false;
  return receipts.some((receipt) => receipt.challengeId === challengeId && receipt.status === 'validated');
}

// True if there is any receipt entry for this challenge (submitted/accepted/validated)
function hasReceiptForChallenge(receipts, challengeId) {
  if (!Array.isArray(receipts) || receipts.length === 0) return false;
  return receipts.some((receipt) => receipt.challengeId === challengeId);
}

/**
 * Submit solutions for a single wallet (after batch generation)
 * Tries solutions in order, continues to next if one fails
 */
async function submitWalletSolutions(wallet, challenge) {
  const { address, folder } = wallet;
  const challengeId = challenge.challenge.challenge_id || challenge.challenge.challengeId;
  const challengeNumber = challenge.challenge.challenge_number || challenge.number;
  const challengeDay = challenge.challenge.day;

  // Check if already solved
  const receipts = await loadReceipts(folder);
  if (isChallengeSolved(receipts, challengeId)) {
    return { skipped: true, reason: 'already solved' };
  }

  // Get solutions for this wallet for the current challenge only (by id or by day+number)
  const solutions = await getSolutionFiles({ id: challengeId, day: challengeDay, number: challengeNumber }, address);
  
  if (solutions.length === 0) {
    return { skipped: true, reason: 'no solutions found' };
  }

  // Build a set of already-submitted salts (nonces) for this challenge to avoid duplicates
  const submittedSalts = new Set(
    receipts
      .filter((r) => r.challengeId === challengeId)
      .map((r) => String(r.salt).toLowerCase())
  );

  // Try each solution until one succeeds, skipping any already-submitted nonce
  // Submission retry config
  // By default, do not retry within the same run. Later polls will pick these up.
  const maxSubmitRetries = Number(process.env.AUTOMATE_SUBMIT_RETRIES ?? 0);
  const baseBackoffMs = Number(process.env.AUTOMATE_SUBMIT_RETRY_BASE_MS ?? 1000);

  for (const item of solutions) {
    // Extract nonce
    let nonce = item.nonce;
    let solution = item.solution;
    if (!nonce && solution?.nonce_hex) nonce = solution.nonce_hex;
    if (!nonce && solution?.nonceHex) nonce = solution.nonceHex;
    if (!nonce && solution?.salt) {
      const match = solution.salt.match(/^([0-9a-fA-F]{16})/);
      if (match) {
        nonce = match[1].toLowerCase();
      }
    }

    if (!nonce) {
      continue; // Try next solution
    }

    const salt = nonce.toLowerCase();
    if (submittedSalts.has(salt)) {
      // Avoid resubmitting the same nonce for this challenge
      continue;
    }

    // Submit solution with limited retries on retryable failures (e.g., 429/5xx)
    let submitResult;
    let attempt = 0;
    while (true) {
      submitResult = await submitSolution(address, challengeId, nonce);
      if (submitResult.success) break;
      const retryable = submitResult.retryable === true;
      if (!retryable || attempt >= maxSubmitRetries) break;
      const retryAfterHeader = submitResult.retryAfter ? Number(submitResult.retryAfter) : null;
      const delay = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : baseBackoffMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
    }

    if (submitResult.success && submitResult.receipt) {
      // Save receipt
      const apiReceipt = submitResult.receipt;
      const challengeData = challenge.challenge;
      const salt = nonce.toLowerCase();
      const hash = apiReceipt.hash || (solution?.digest_hex || solution?.digestHex) || null;
      const cryptoReceiptData = apiReceipt.crypto_receipt || apiReceipt.cryptoReceipt || {};
      
      const submittedAtValue = apiReceipt.submittedAt || apiReceipt.submitted_at || cryptoReceiptData.timestamp || new Date().toISOString();
      const isValidated = apiReceipt.status === 'validated';
      
      const receiptData = {
        challengeId: challengeId,
        challengeNumber: challengeData.challenge_number || challenge.number,
        challengeTotal: challengeData.challenge_total || challengeData.total_challenges || 504,
        campaignDay: challengeData.day || challengeData.campaign_day || null,
        difficulty: challengeData.difficulty,
        status: apiReceipt.status || 'submitted',
        noPreMine: challengeData.no_pre_mine || challengeData.noPreMine,
        noPreMineHour: challengeData.no_pre_mine_hour || challengeData.noPreMineHour,
        latestSubmission: challengeData.latest_submission || challengeData.latestSubmission,
        availableAt: challengeData.issued_at || challengeData.availableAt || challengeData.issuedAt,
        acceptedAt: apiReceipt.acceptedAt || apiReceipt.accepted_at || cryptoReceiptData.timestamp || new Date().toISOString(),
        solvedAt: apiReceipt.solvedAt || apiReceipt.solved_at || cryptoReceiptData.timestamp || new Date().toISOString(),
        validatedAt: isValidated ? (apiReceipt.validatedAt || apiReceipt.validated_at || submittedAtValue) : null,
        submittedAt: submittedAtValue,
        salt: salt,
        hash: hash,
        cryptoReceipt: {
          preimage: cryptoReceiptData.preimage || null,
          timestamp: cryptoReceiptData.timestamp || new Date().toISOString(),
          signature: cryptoReceiptData.signature || null,
        },
      };

      const existingIndex = receipts.findIndex(
        (r) => r.challengeId === challengeId && r.salt === salt
      );

      if (existingIndex >= 0) {
        receipts[existingIndex] = receiptData;
      } else {
        receipts.push(receiptData);
      }

      await saveReceipts(folder, receipts);
      submittedSalts.add(salt);
      
      return { 
        success: true, 
        status: apiReceipt.status,
        validated: apiReceipt.status === 'validated'
      };
    }
    // If submission failed, continue to next solution
  }

  return { skipped: true, reason: 'all solutions failed' };
}

/**
 * Process wallets in batch: generate solutions first, then submit
 */
async function processWalletsBatch(solverBin, wallets, challenge, concurrency = 5) {
  const challengeId = challenge.challenge.challenge_id || challenge.challenge.challengeId;
  const challengeNumber = challenge.challenge.challenge_number || challenge.number;

  console.log(`\n=== Batch Processing ${wallets.length} wallet(s) ===`);
  console.log(`Challenge: ${challengeId} (${challengeNumber})`);

  const timings = {
    generationMs: 0,
    submissionMs: 0,
  };

  // Filter out wallets that are already solved
  const walletsToProcess = [];
  for (const wallet of wallets) {
    const receipts = await loadReceipts(wallet.folder);
    // Skip any wallet that already has a receipt entry for this challenge (any status)
    if (!hasReceiptForChallenge(receipts, challengeId)) {
      walletsToProcess.push(wallet);
    }
  }

  if (walletsToProcess.length === 0) {
    console.log(`All wallets already solved for challenge ${challengeId}`);
    return {
      results: { success: 0, skipped: wallets.length, failed: 0, validated: 0 },
      timings,
      meta: {
        walletsWithSolutions: wallets.length,
        walletsNeedingGeneration: 0,
        walletsForSubmit: 0,
      }
    };
  }

  console.log(`Processing ${walletsToProcess.length} wallet(s) that need solutions...`);

  // Determine which wallets already have at least one solution file for this challenge
  const challengeMeta = { id: challengeId, day: challenge.challenge.day, number: challengeNumber };
  const withSolutionsChecks = await Promise.all(
    walletsToProcess.map(async (w) => {
      const sols = await getSolutionFiles(challengeMeta, w.address);
      return { wallet: w, has: sols.length > 0 };
    })
  );
  const walletsWithSolutions = withSolutionsChecks.filter(x => x.has).map(x => x.wallet);
  const walletsNeedingGen = withSolutionsChecks.filter(x => !x.has).map(x => x.wallet);

  const submitOnly = process.env.AUTOMATE_SUBMIT_ONLY === '1';

  let step1Duration = 0;
  if (!submitOnly && walletsNeedingGen.length > 0) {
    console.log(`\n[Step 1/2] Generating solutions for ${walletsNeedingGen.length} wallet(s)...`);
    const step1StartTime = Date.now();
    const addresses = walletsNeedingGen.map(w => w.address);
    const batchSolverResult = await runBatchSolver(solverBin, addresses, challenge.path, SOLUTIONS_BASE_DIR);
    const step1EndTime = Date.now();
    step1Duration = step1EndTime - step1StartTime;
    timings.generationMs = step1Duration;
    const step1Seconds = (step1Duration / 1000).toFixed(2);
    const step1Minutes = Math.floor(step1Duration / 60000);
    const step1RemainingSeconds = ((step1Duration % 60000) / 1000).toFixed(2);

    if (!batchSolverResult.success) {
      console.error(`Batch solver failed, cannot proceed with submissions`);
      return {
        results: {
          success: 0,
          skipped: walletsNeedingGen.length,
          failed: walletsNeedingGen.length,
          validated: 0,
        },
        timings,
        meta: {
          walletsWithSolutions: walletsWithSolutions.length,
          walletsNeedingGeneration: walletsNeedingGen.length,
          walletsForSubmit: walletsWithSolutions.length,
        }
      };
    }

    if (step1Minutes > 0) {
      console.log(`Solutions generated successfully in ${step1Minutes}m ${step1RemainingSeconds}s (${step1Duration}ms)\n`);
    } else {
      console.log(`Solutions generated successfully in ${step1Seconds}s (${step1Duration}ms)\n`);
    }
  } else {
    console.log(`\n[Step 1/2] Skipping generation: ${walletsWithSolutions.length} wallet(s) already have solutions.`);
  }

  // Step 2: Submit solutions for all wallets concurrently
  // Union of wallets with existing solutions and those just generated
  const walletsForSubmit = walletsWithSolutions.length > 0 || walletsNeedingGen.length > 0
    ? walletsWithSolutions.concat(walletsNeedingGen)
    : walletsToProcess;

  const meta = {
    walletsWithSolutions: walletsWithSolutions.length,
    walletsNeedingGeneration: walletsNeedingGen.length,
    walletsForSubmit: walletsForSubmit.length,
  };

  console.log(`[Step 2/2] Submitting solutions for ${walletsForSubmit.length} wallet(s)...`);
  const step2StartTime = Date.now();
  const results = {
    success: 0,
    skipped: 0,
    failed: 0,
    validated: 0
  };
  const skipReasons = new Map();

  // Process wallets in batches with concurrency limit
  for (let i = 0; i < walletsForSubmit.length; i += concurrency) {
    const batch = walletsForSubmit.slice(i, i + concurrency);
    const batchPromises = batch.map(wallet => submitWalletSolutions(wallet, challenge));
    const batchResults = await Promise.all(batchPromises);

    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j];
      const wallet = batch[j];
      
      if (result.success) {
        results.success++;
        if (result.validated) {
          results.validated++;
        }
        // Don't log individual submissions - only show summary at end
      } else if (result.skipped) {
        results.skipped++;
        // Collect reason breakdown and optionally log
        const reason = result.reason || 'unknown';
        skipReasons.set(reason, (skipReasons.get(reason) || 0) + 1);
        if (process.env.AUTOMATE_LOG_SKIPPED === '1') {
          console.log(`⏭️  ${wallet.address.substring(0, 40)}... - ${reason}`);
        }
      } else {
        results.failed++;
        // Don't log individual failures - only show summary at end
      }
    }

    // Small delay between batches
    if (i + concurrency < walletsForSubmit.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  const step2EndTime = Date.now();
  const step2Duration = step2EndTime - step2StartTime;
  const step2Seconds = (step2Duration / 1000).toFixed(2);
  const step2Minutes = Math.floor(step2Duration / 60000);
  const step2RemainingSeconds = ((step2Duration % 60000) / 1000).toFixed(2);
  timings.submissionMs = step2Duration;

  // Compute generation time display from step1Duration (may be 0 if skipped)
  const step1Seconds = (step1Duration / 1000).toFixed(2);
  const step1Minutes = Math.floor(step1Duration / 60000);
  const step1RemainingSeconds = ((step1Duration % 60000) / 1000).toFixed(2);

  console.log(`\nTiming Summary:`);
  if (step1Minutes > 0) {
    console.log(`  Step 1 (Generation): ${step1Minutes}m ${step1RemainingSeconds}s (${step1Duration}ms)`);
  } else {
    console.log(`  Step 1 (Generation): ${step1Seconds}s (${step1Duration}ms)`);
  }
  if (step2Minutes > 0) {
    console.log(`  Step 2 (Submission): ${step2Minutes}m ${step2RemainingSeconds}s (${step2Duration}ms)`);
  } else {
    console.log(`  Step 2 (Submission): ${step2Seconds}s (${step2Duration}ms)`);
  }
  console.log(`\nResults: ${results.success} succeeded (${results.validated} validated), ${results.skipped} skipped, ${results.failed} failed`);
  if (skipReasons.size > 0) {
    console.log('Skip reasons:');
    for (const [reason, count] of skipReasons.entries()) {
      console.log(`  - ${reason}: ${count}`);
    }
  }
  return { results, timings, meta };
}

/**
 * OLD: Process a single wallet: run solver, get solution, submit, save receipt if successful
 * Retries with new solutions if "solution already exists"
 * DEPRECATED: Use batch flow instead
 */
async function processWallet_OLD(solverBin, wallet, challenge, maxRetries = 3) {
  const { address, folder } = wallet;
  const challengeId = challenge.challenge.challenge_id || challenge.challenge.challengeId;
  const challengeNumber = challenge.challenge.challenge_number || challenge.number;

  // Check if already solved
  const receipts = await loadReceipts(folder);
  if (isChallengeSolved(receipts, challengeId)) {
    return { skipped: true, reason: 'already solved' };
  }

  // Track tried nonces to avoid submitting the same one twice
  const triedNonces = new Set();
  // Start with a random offset to avoid collisions between concurrent wallets
  let suffixOffset = Math.floor(Math.random() * 1000000);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Run solver for this wallet with incremental suffix offset for retries
      const solverResult = await runSolver(solverBin, address, challenge.path, suffixOffset);
      
      if (!solverResult.success || !solverResult.solutionPath) {
        if (attempt === maxRetries - 1) {
          return { skipped: true, reason: 'solver failed' };
        }
        continue; // Try again
      }

      // Read the solution file
      let solution;
      try {
        const solutionContent = await fs.readFile(solverResult.solutionPath, 'utf8');
        solution = JSON.parse(solutionContent);
      } catch (err) {
        console.error(`Failed to read solution for ${address.substring(0, 20)}...:`, err.message);
        if (attempt === maxRetries - 1) {
          return { skipped: true, reason: 'failed to read solution' };
        }
        continue; // Try again
      }

      // Extract nonce
      let nonce = solution.nonce_hex || solution.nonceHex;
      if (!nonce && solution.salt) {
        const match = solution.salt.match(/^([0-9a-f]{16})/);
        if (match) {
          nonce = match[1];
        }
      }

      if (!nonce) {
        console.error(`No nonce found in solution for ${address.substring(0, 20)}...`);
        if (attempt === maxRetries - 1) {
          return { skipped: true, reason: 'no nonce in solution' };
        }
        continue; // Try again
      }

      // Skip if we've already tried this nonce
      if (triedNonces.has(nonce.toLowerCase())) {
        // Delete the solution file so solver generates a fresh one next time
        try {
          await fs.unlink(solverResult.solutionPath);
        } catch (err) {
          // Ignore deletion errors
        }
        if (attempt === maxRetries - 1) {
          return { skipped: true, reason: 'no new solutions found' };
        }
        // Increase offset more aggressively when we get duplicate nonces
        suffixOffset += 50000; // Jump ahead by 50k
        continue; // Try again for a different solution
      }

      triedNonces.add(nonce.toLowerCase());

      // Submit solution
      const submitResult = await submitSolution(address, challengeId, nonce);

      if (submitResult.success && submitResult.receipt) {
        // Save receipt
        const apiReceipt = submitResult.receipt;
        const challengeData = challenge.challenge;
        const salt = nonce.toLowerCase();
        const hash = apiReceipt.hash || solution.digest_hex || solution.digestHex || null;
        const cryptoReceiptData = apiReceipt.crypto_receipt || apiReceipt.cryptoReceipt || {};
        
        const submittedAtValue = apiReceipt.submittedAt || apiReceipt.submitted_at || cryptoReceiptData.timestamp || new Date().toISOString();
        const isValidated = apiReceipt.status === 'validated';
        
        const receiptData = {
          challengeId: challengeId,
          challengeNumber: challengeData.challenge_number || challenge.number,
          challengeTotal: challengeData.challenge_total || challengeData.total_challenges || 504,
          campaignDay: challengeData.day || challengeData.campaign_day || null,
          difficulty: challengeData.difficulty,
          status: apiReceipt.status || 'submitted',
          noPreMine: challengeData.no_pre_mine || challengeData.noPreMine,
          noPreMineHour: challengeData.no_pre_mine_hour || challengeData.noPreMineHour,
          latestSubmission: challengeData.latest_submission || challengeData.latestSubmission,
          availableAt: challengeData.issued_at || challengeData.availableAt || challengeData.issuedAt,
          acceptedAt: apiReceipt.acceptedAt || apiReceipt.accepted_at || cryptoReceiptData.timestamp || new Date().toISOString(),
          solvedAt: apiReceipt.solvedAt || apiReceipt.solved_at || cryptoReceiptData.timestamp || new Date().toISOString(),
          validatedAt: isValidated ? (apiReceipt.validatedAt || apiReceipt.validated_at || submittedAtValue) : null,
          submittedAt: submittedAtValue,
          salt: salt,
          hash: hash,
          cryptoReceipt: {
            preimage: cryptoReceiptData.preimage || null,
            timestamp: cryptoReceiptData.timestamp || new Date().toISOString(),
            signature: cryptoReceiptData.signature || null,
          },
        };

        const existingIndex = receipts.findIndex(
          (r) => r.challengeId === challengeId && r.salt === salt
        );

        if (existingIndex >= 0) {
          receipts[existingIndex] = receiptData;
        } else {
          receipts.push(receiptData);
        }

        await saveReceipts(folder, receipts);
        console.log(
          `Receipt saved for ${address} at ${path.relative(
            ROOT_DIR,
            getReceiptFilePath(folder)
          )}`
        );
        
        // Clean up solution file after successful submission
        try {
          await fs.unlink(solverResult.solutionPath);
        } catch (err) {
          // Ignore deletion errors
        }
        
        return { 
          success: true, 
          status: apiReceipt.status,
          validated: apiReceipt.status === 'validated',
          attempts: attempt + 1
        };
      } else {
        // Submission failed - try generating a new solution
        const isAlreadyExists = submitResult.body?.message?.includes('Solution already exists') ||
                                submitResult.body?.message?.includes('already exists') ||
                                submitResult.rawBody?.includes('Solution already exists') ||
                                submitResult.rawBody?.includes('already exists');

        const errorReason = isAlreadyExists 
          ? `solution already exists` 
          : `submission failed: ${submitResult.status || 'unknown error'}`;

        if (attempt < maxRetries - 1) {
          console.log(`⚠️  ${errorReason} for ${address.substring(0, 20)}... (nonce: ${nonce}), generating new solution...`);
          // Delete the solution file so solver generates a fresh one
          try {
            await fs.unlink(solverResult.solutionPath);
          } catch (err) {
            // Ignore deletion errors
          }
          // Increment suffix offset to search from a different starting point
          suffixOffset += Math.floor(100000 + Math.random() * 100000); // Jump ahead by 100k-200k randomly
          // Small delay before retrying
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue; // Try again with a new solution
        } else {
          // Clean up solution file before returning
          try {
            await fs.unlink(solverResult.solutionPath);
          } catch (err) {
            // Ignore deletion errors
          }
          return { skipped: true, reason: `${errorReason} (max retries reached)` };
        }
      }
    } catch (error) {
      console.error(`Error processing wallet ${address.substring(0, 20)}... (attempt ${attempt + 1}):`, error.message);
      if (attempt === maxRetries - 1) {
        return { skipped: true, reason: `error: ${error.message}` };
      }
      // Continue to next attempt
    }
  }

  return { skipped: true, reason: 'max retries reached' };
}

/**
 * Process wallets concurrently with a concurrency limit
 */
async function processWalletsConcurrent(solverBin, wallets, challenge, concurrency = 5) {
  const challengeId = challenge.challenge.challenge_id || challenge.challenge.challengeId;
  const challengeNumber = challenge.challenge.challenge_number || challenge.number;

  console.log(`\n=== Processing ${wallets.length} wallet(s) concurrently (limit: ${concurrency}) ===`);
  console.log(`Challenge: ${challengeId} (${challengeNumber})`);

  const results = {
    success: 0,
    skipped: 0,
    failed: 0,
    validated: 0
  };

  // Process wallets in batches with concurrency limit
  for (let i = 0; i < wallets.length; i += concurrency) {
    const batch = wallets.slice(i, i + concurrency);
    const batchPromises = batch.map(wallet => processWallet(solverBin, wallet, challenge));
    const batchResults = await Promise.all(batchPromises);

    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j];
      const wallet = batch[j];
      
      if (result.success) {
        results.success++;
        if (result.validated) {
          results.validated++;
          console.log(`✅ ${wallet.address.substring(0, 40)}... - Validated!`);
        } else {
          console.log(`✅ ${wallet.address.substring(0, 40)}... - Submitted`);
        }
      } else if (result.skipped) {
        results.skipped++;
        if (result.reason !== 'already solved') {
          console.log(`⏭️  ${wallet.address.substring(0, 40)}... - ${result.reason}`);
        }
      } else {
        results.failed++;
        console.log(`❌ ${wallet.address.substring(0, 40)}... - Failed`);
      }
    }

    // Small delay between batches to avoid overwhelming the system
    if (i + concurrency < wallets.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  console.log(`\nResults: ${results.success} succeeded (${results.validated} validated), ${results.skipped} skipped, ${results.failed} failed`);
  return results;
}

/**
 * Process solutions for a single wallet (after solver has run)
 */
async function processWalletSolutions(wallet, challenge) {
  const { address, folder } = wallet;
  const challengeId = challenge.challenge.challenge_id || challenge.challenge.challengeId;
  const challengeNumber = challenge.challenge.challenge_number || challenge.number;
  const challengeDay = challenge.challenge.day;

  console.log(`\n=== Processing solutions for wallet: ${address} ===`);

  // Get solution files for current challenge (by id or day+number)
  const solutions = await getSolutionFiles({ id: challengeId, day: challengeDay, number: challengeNumber }, address);
  console.log(`Found ${solutions.length} solution(s) for ${address}`);

  if (solutions.length === 0) {
    console.warn(`No solutions found for ${address}`);
    return;
  }

  // Load receipts for this wallet
  const receipts = await loadReceipts(folder);
  const submittedSalts = new Set(
    receipts
      .filter((r) => r.challengeId === challengeId)
      .map((r) => String(r.salt).toLowerCase())
  );

  // Submit solutions
  for (const item of solutions) {
    const solution = item.solution;
    // Extract nonce - it might be in nonce_hex field or we need to extract from salt
    let nonce = item.nonce || (solution && (solution.nonce_hex || solution.nonceHex));
    if (!nonce && solution?.salt) {
      // Extract first 16 hex characters from salt (nonce is first 16 hex chars)
      const match = solution.salt.match(/^([0-9a-fA-F]{16})/);
      if (match) {
        nonce = match[1].toLowerCase();
      }
    }

    if (!nonce) {
      console.warn(`Solution missing nonce:`, solution ?? item);
      continue;
    }

    const salt = nonce.toLowerCase();
    if (submittedSalts.has(salt)) {
      // Already submitted this nonce for this challenge; skip
      continue;
    }

    console.log(`Submitting solution with nonce ${nonce}...`);
    const submitResult = await submitSolution(address, challengeId, nonce);

    if (submitResult.success && submitResult.receipt) {
      console.log(`✅ Successfully submitted solution!`);
      console.log(`Status: ${submitResult.status} ${submitResult.statusText}`);

      // Build proper receipt from API response and challenge data
      const apiReceipt = submitResult.receipt;
      const challengeData = challenge.challenge;
      
      // Extract salt from nonce (first 16 hex chars) - lowercase
      const salt = nonce.toLowerCase();
      
      // Get hash from solution or API response
      const hash = apiReceipt.hash || (solution?.digest_hex || solution?.digestHex) || null;
      
      // Get crypto receipt data (handle both snake_case and camelCase)
      const cryptoReceiptData = apiReceipt.crypto_receipt || apiReceipt.cryptoReceipt || {};
      
      // Build the receipt object with all required fields matching the expected format
      const submittedAtValue = apiReceipt.submittedAt || apiReceipt.submitted_at || cryptoReceiptData.timestamp || new Date().toISOString();
      const isValidated = apiReceipt.status === 'validated';
      
      const receiptData = {
        challengeId: challengeId,
        challengeNumber: challengeData.challenge_number || challenge.number,
        challengeTotal: challengeData.challenge_total || challengeData.total_challenges || 504,
        campaignDay: challengeData.day || challengeData.campaign_day || null,
        difficulty: challengeData.difficulty,
        status: apiReceipt.status || 'submitted',
        noPreMine: challengeData.no_pre_mine || challengeData.noPreMine,
        noPreMineHour: challengeData.no_pre_mine_hour || challengeData.noPreMineHour,
        latestSubmission: challengeData.latest_submission || challengeData.latestSubmission,
        availableAt: challengeData.issued_at || challengeData.availableAt || challengeData.issuedAt,
        acceptedAt: apiReceipt.acceptedAt || apiReceipt.accepted_at || cryptoReceiptData.timestamp || new Date().toISOString(),
        solvedAt: apiReceipt.solvedAt || apiReceipt.solved_at || cryptoReceiptData.timestamp || new Date().toISOString(),
        validatedAt: isValidated ? (apiReceipt.validatedAt || apiReceipt.validated_at || submittedAtValue) : null,
        submittedAt: submittedAtValue,
        salt: salt,
        hash: hash,
        cryptoReceipt: {
          preimage: cryptoReceiptData.preimage || null,
          timestamp: cryptoReceiptData.timestamp || new Date().toISOString(),
          signature: cryptoReceiptData.signature || null,
        },
      };

      // Check if this receipt already exists (by challengeId and salt)
      const existingIndex = receipts.findIndex(
        (r) => r.challengeId === challengeId && r.salt === salt
      );

      if (existingIndex >= 0) {
        receipts[existingIndex] = receiptData;
      } else {
        receipts.push(receiptData);
      }

      await saveReceipts(folder, receipts);
      submittedSalts.add(salt);
      console.log(
        `Receipt saved for ${address} at ${path.relative(
          ROOT_DIR,
          getReceiptFilePath(folder)
        )}`
      );

      // If validated, we can stop trying other solutions
      if (receiptData.status === 'validated') {
        console.log(`Challenge ${challengeId} validated for ${address}!`);
        break;
      }
    } else {
      // Check if the error is "Solution already exists"
      const isAlreadyExists = submitResult.body?.message?.includes('Solution already exists') ||
                              submitResult.body?.message?.includes('already exists') ||
                              submitResult.rawBody?.includes('Solution already exists') ||
                              submitResult.rawBody?.includes('already exists');

      if (isAlreadyExists) {
        console.log(`⚠️  Solution already exists, trying next solution...`);
        // Continue to next solution
      } else {
        console.error(`❌ Submission failed:`, submitResult);
        if (submitResult.body) {
          console.error(`Response body:`, JSON.stringify(submitResult.body, null, 2));
        }
        // Continue to next solution anyway, but log the error
      }
    }

    // Small delay between submissions
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = { from: null, to: null };
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from' || arg === '-f') {
      if (i + 1 < argv.length) {
        args.from = parseInt(argv[++i], 10);
      }
    } else if (arg === '--to' || arg === '-t') {
      if (i + 1 < argv.length) {
        args.to = parseInt(argv[++i], 10);
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
AshMaize Automation Script

Usage:
  node automate-solver.js [--from INDEX] [--to INDEX]
  node automate-solver.js [START_INDEX] [END_INDEX]

Options:
  --from, -f INDEX    Start processing from wallet index (1-based, inclusive)
  --to, -t INDEX      Stop processing at wallet index (1-based, inclusive)
  --help, -h          Show this help message

Examples:
  node automate-solver.js                    # Process all wallets
  node automate-solver.js --from 1 --to 10   # Process wallets 1-10
  node automate-solver.js 1 10               # Process wallets 1-10
  node automate-solver.js --from 100         # Process wallets from index 100 to end
  node automate-solver.js --to 50            # Process wallets 1-50

Note: Indexes are 1-based (first wallet is index 1). If --to is not specified, all remaining wallets are processed.
`);
      process.exit(0);
    } else if (!isNaN(parseInt(arg, 10))) {
      // Positional arguments
      if (args.from === null) {
        args.from = parseInt(arg, 10);
      } else if (args.to === null) {
        args.to = parseInt(arg, 10);
      }
    }
  }

  return args;
}

/**
 * Main function
 */
async function main() {
  // Start timing
  const startTime = Date.now();
  
  // Parse command line arguments
  const args = parseArgs();

  console.log('=== AshMaize Automation Script ===\n');
  console.log(`Started at: ${new Date().toISOString()}\n`);

  // Find batch solver binary
  console.log('Looking for batch solver binary...');
  const solverBin = await findSolverBinary('solve-batch');
  console.log(`Using batch solver: ${solverBin}\n`);

  // Ensure directories exist
  await fs.mkdir(SOLUTIONS_BASE_DIR, { recursive: true });

  // Get current challenge
  console.log('Getting current challenge...');
  const challenge = await getCurrentChallenge();
  console.log(`Current challenge: ${challenge.challenge.challenge_id || challenge.challenge.challengeId} (${challenge.number})`);

  // Get all wallets
  console.log('\nScanning wallets...');
  const allWallets = await getWalletAddresses();
  console.log(`Found ${allWallets.length} wallet(s)`);

  if (allWallets.length === 0) {
    console.error('No wallets found!');
    process.exit(1);
  }

  // Convert 1-based user input to 0-based array indexes
  // User says 1-10, we need array indexes 0-9 (inclusive)
  const userStart = args.from !== null ? Math.max(1, args.from) : 1;
  const userEnd = args.to !== null ? Math.min(allWallets.length, args.to) : allWallets.length;

  if (userStart > userEnd) {
    console.error(`Invalid range: start index (${userStart}) must be less than or equal to end index (${userEnd})`);
    process.exit(1);
  }

  if (userStart < 1 || userEnd > allWallets.length) {
    console.error(`Invalid range: indexes must be between 1 and ${allWallets.length}`);
    process.exit(1);
  }

  // Convert to 0-based for array operations
  // User says "1 to 10" → array indexes 0-9 → slice(0, 10)
  const startIndex = userStart - 1; // Convert 1-based to 0-based
  const endIndex = userEnd; // slice uses exclusive end, so userEnd (1-based) works directly

  // Filter wallets based on range
  const wallets = allWallets.slice(startIndex, endIndex);
  console.log(`Processing wallets ${userStart} to ${userEnd} (${wallets.length} wallet(s))`);

  // Process wallets using batch flow (generate solutions first, then submit)
  let batchReport = null;
  try {
    batchReport = await processWalletsBatch(solverBin, wallets, challenge, 5);
  } catch (error) {
    console.error(`Error processing wallets:`, error);
  }

  const reportTimestamp = Math.floor(Date.now() / 1000);
  if (batchReport?.results) {
    const challengeIdentifier =
      challenge.challenge.challenge_id ||
      challenge.challenge.challengeId ||
      (challenge.number !== undefined ? String(challenge.number) : null);

    const automationReport = {
      challengeId: challengeIdentifier,
      solutions: {
        succeded: batchReport.results.success ?? 0,
        skipped: batchReport.results.skipped ?? 0,
        failed: batchReport.results.failed ?? 0,
        validated: batchReport.results.validated ?? 0,
      },
      timings: {
        generationMs: batchReport.timings?.generationMs ?? 0,
        submissionMs: batchReport.timings?.submissionMs ?? 0,
      },
      walletsProcessed: batchReport.meta?.walletsForSubmit ?? wallets.length,
      timeStamp: reportTimestamp,
      dataDir: process.env.ASHMAIZE_DATA_DIR ?? DATA_FINAL_DIR,
    };

    console.log(`AUTOMATE_SOLVER_RESULT ${JSON.stringify(automationReport)}`);

    try {
      await sendDiagnosticsReport(batchReport, challenge.challenge, reportTimestamp);
    } catch (diagnosticsError) {
      console.warn(
        `[${new Date().toISOString()}] Diagnostics dispatch failed: ${diagnosticsError.message}`
      );
    }
  }

  // End timing
  const endTime = Date.now();
  const duration = endTime - startTime;
  const seconds = (duration / 1000).toFixed(2);
  const minutes = Math.floor(duration / 60000);
  const remainingSeconds = ((duration % 60000) / 1000).toFixed(2);

  console.log('\n=== Done ===');
  console.log(`Finished at: ${new Date().toISOString()}`);
  if (minutes > 0) {
    console.log(`Total duration: ${minutes}m ${remainingSeconds}s (${duration}ms)`);
  } else {
    console.log(`Total duration: ${seconds}s (${duration}ms)`);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
