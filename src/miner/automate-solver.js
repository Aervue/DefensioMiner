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
import { spawn, exec } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';
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

  const asDescriptor = (command, args = []) => ({
    command,
    args,
    label: args.length ? `${command} ${args.join(' ')}` : command
  });

  try {
    await fs.access(releaseBin);
    if (await isElfExecutable(releaseBin)) {
      return asDescriptor(releaseBin);
    }
    console.warn(
      `Warning: Release binary '${releaseBin}' is not a Linux ELF executable. Trying debug build...`
    );
  } catch {
    // Ignore and try debug build
  }

  try {
    await fs.access(debugBin);
    if (await isElfExecutable(debugBin)) {
      console.warn(`Warning: Using debug build instead of release build`);
      return asDescriptor(debugBin);
    }
    console.warn(`Warning: Debug binary '${debugBin}' is not a Linux ELF executable.`);
  } catch {
    // Fall through to error
  }

  console.warn(`Falling back to running '${binaryName}' via cargo. This may trigger a compilation step.`);
  return asDescriptor('cargo', ['run', '--release', '--bin', binaryName, '--']);
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

const numberFormatter = new Intl.NumberFormat('en-US');
const formatNumber = (value) => {
  if (value === null || value === undefined) return '–';
  return numberFormatter.format(Math.round(value));
};

const formatDuration = (ms) => {
  if (!Number.isFinite(ms)) return '–';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = (seconds % 60).toFixed(1);
  return `${minutes}m ${remainingSeconds}s`;
};

const formatHashRate = (rate) => {
  if (!Number.isFinite(rate) || rate <= 0) return '–';
  if (rate >= 1_000_000) return `${(rate / 1_000_000).toFixed(2)} MH/s`;
  if (rate >= 1_000) return `${(rate / 1_000).toFixed(2)} kH/s`;
  return `${rate.toFixed(2)} H/s`;
};

const shortAddress = (address = '', keep = 6) => {
  if (!address || address.length <= keep * 2 + 1) return address || 'unknown';
  return `${address.slice(0, keep)}…${address.slice(-keep)}`;
};

const formatNonce = (nonce) => {
  if (!nonce) return 'n/a';
  if (nonce.length <= 8) return nonce;
  return `${nonce.slice(0, 4)}…${nonce.slice(-4)}`;
};

const logSection = (title, rows) => {
  const normalizedRows = rows.filter(Boolean);
  if (!normalizedRows.length) return;
  console.log(`\n${chalk.bold.cyan(title)}`);
  for (const [label, value] of normalizedRows) {
    console.log(`${chalk.gray('  •')} ${chalk.dim(label)} ${chalk.white(value)}`);
  }
};

const clearActiveLine = () => {
  process.stdout.write('\r\x1B[K');
};

const createTicker = (label) => {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIndex = 0;
  let extra = '';
  const start = Date.now();
  const render = () => {
    const message = `${chalk.yellow(frames[frameIndex])} ${chalk.white(label)} ${chalk.gray(
      formatDuration(Date.now() - start)
    )}${extra ? chalk.gray(' · ') + extra : ''}`;
    clearActiveLine();
    process.stdout.write(message);
    frameIndex = (frameIndex + 1) % frames.length;
  };
  const timer = setInterval(render, 120);
  render();
  return {
    update(text) {
      extra = text;
    },
    stop(finalMessage) {
      clearInterval(timer);
      clearActiveLine();
      if (finalMessage) {
        console.log(finalMessage);
      }
    }
  };
};

const quoteArg = (value = '') => {
  if (/^[A-Za-z0-9._\-/:=+]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
};

const buildCommandString = (descriptor, extraArgs = []) => {
  const parts = [descriptor.command, ...(descriptor.args ?? []), ...extraArgs];
  return parts.map(quoteArg).join(' ');
};

const extractSolutionMetrics = (solution) => {
  if (!solution) {
    return { hashRate: null, totalHashes: null, elapsedMs: null };
  }
  const elapsedSeconds = Number(solution.elapsed_seconds ?? solution.elapsedSeconds);
  let totalHashes = solution.total_hashes ?? solution.totalHashes ?? solution.hashes;
  totalHashes =
    typeof totalHashes === 'string'
      ? Number(totalHashes.replace(/_/g, ''))
      : Number(totalHashes);
  let hashRate = Number(solution.hash_rate_hs ?? solution.hashRateHs ?? solution.hash_rate);
  if ((!Number.isFinite(hashRate) || hashRate <= 0) && Number.isFinite(totalHashes) && Number.isFinite(elapsedSeconds) && elapsedSeconds > 0) {
    hashRate = totalHashes / elapsedSeconds;
  }
  const elapsedMs =
    Number.isFinite(elapsedSeconds) && elapsedSeconds >= 0 ? elapsedSeconds * 1000 : null;
  return {
    hashRate: Number.isFinite(hashRate) ? hashRate : null,
    totalHashes: Number.isFinite(totalHashes) ? totalHashes : null,
    elapsedMs
  };
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
  const extraArgs = ['--address', walletAddress, challengePath];
  const command = buildCommandString(solverBin, extraArgs);

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
  const tempFile = path.join(SOLVER_ROOT, `.batch_addresses_${Date.now()}.txt`);
  try {
    await fs.writeFile(tempFile, walletAddresses.join('\n') + '\n', 'utf8');
  } catch (error) {
    console.error(`Failed to create addresses file:`, error.message);
    return { success: false, error: error.message };
  }

  const ticker = createTicker('hashing');
  let lastRate = null;
  const updateRate = (rate) => {
    if (!Number.isFinite(rate) || rate <= 0) return;
    lastRate = rate;
    ticker.update(chalk.blue(formatHashRate(rate)));
  };
  const args = [
    ...(solverBin.args ?? []),
    '--addresses',
    tempFile,
    '--solutions-dir',
    solutionsDir,
    challengePath
  ];

  return await new Promise((resolve) => {
    const child = spawn(solverBin.command, args, {
      cwd: SOLVER_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdoutBuffer = '';
    let solverResult = null;

    const handleLine = (line) => {
      const progressMatch = line.match(/Checked\s+([\d,]+)\s+salts\s+—\s+([0-9.]+)\s+H\/s/i);
      if (progressMatch) {
        const rate = Number(progressMatch[2]);
        updateRate(rate);
        return;
      }
      const resultMatch = line.match(/AUTOMATE_SOLVER_RESULT\s+(.*)$/);
      if (resultMatch) {
        try {
          solverResult = JSON.parse(resultMatch[1]);
          const hr =
            solverResult?.performance?.totalHashRate ??
            solverResult?.performance?.hash_rate_hs ??
            solverResult?.hash_rate_hs ??
            solverResult?.hashRateHs ??
            null;
          updateRate(hr);
        } catch {
          // ignore parse errors
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (process.env.AUTOMATE_SOLVER_RAW_LOGS === '1') {
        process.stdout.write(chalk.dim(text));
      }
      stdoutBuffer += text;
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.length) {
          handleLine(line);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      if (process.env.AUTOMATE_SOLVER_RAW_LOGS === '1') {
        process.stderr.write(chalk.dim(chunk.toString()));
      }
    });

    const finalize = async (result) => {
      const finalMessage = result.success
        ? `${chalk.green('✓')} hashing ${chalk.gray(formatHashRate(lastRate))}`
        : `${chalk.red('✖')} solver failed${result.error ? `: ${result.error}` : ''}`;
      ticker.stop(finalMessage.trim());
      try {
        await fs.unlink(tempFile);
      } catch {}
      resolve({ ...result, solverResult });
    };

    child.on('error', (error) => {
      finalize({ success: false, error: error.message });
    });

    child.on('exit', (code) => {
      finalize({ success: code === 0 });
    });
  });
}

/**
 * Submit a solution
 */
async function submitSolution(address, challengeId, nonce) {
  const url = `${SUBMIT_URL_BASE}/${address}/${challengeId}/${nonce}`;
  console.log(`→ Submitting ${shortAddress(address, 10)} · nonce ${formatNonce(nonce)}`);

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
  const solutions = await getSolutionFiles(
    { id: challengeId, day: challengeDay, number: challengeNumber },
    address
  );
  
  if (solutions.length === 0) {
    return { skipped: true, reason: 'no solutions found', walletAddress: address };
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

    if (!solution) {
      try {
        const solutionContent = await fs.readFile(item.file, 'utf8');
        solution = JSON.parse(solutionContent);
      } catch (error) {
        console.warn(`Failed to read solution file ${item.file}: ${error.message}`);
        continue;
      }
    }

    const metrics = extractSolutionMetrics(solution);

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
        validated: apiReceipt.status === 'validated',
        hashRate: metrics.hashRate,
        totalHashes: metrics.totalHashes,
        elapsedMs: metrics.elapsedMs,
        walletAddress: address,
        nonce
      };
    }
    // If submission failed, continue to next solution
  }

  return { skipped: true, reason: 'all solutions failed', errors: failureDetails, walletAddress: address };
}

/**
 * Process wallets in batch: generate solutions first, then submit
 */
async function processWalletsBatch(solverBin, wallets, challenge, concurrency = 5) {
  const challengeId = challenge.challenge.challenge_id || challenge.challenge.challengeId;
  const challengeNumber = challenge.challenge.challenge_number || challenge.number;
  const challengeDay = challenge.challenge.day ?? 'n/a';

  console.log(
    `\n${chalk.bgMagenta.black(' CHALLENGE ')} ${chalk.magenta(challengeId)} ${chalk.gray(
      `day ${challengeDay} · #${challengeNumber}`
    )}`
  );
  logSection('Batch', [
    ['Wallets requested', `${wallets.length}`],
    ['Concurrency', concurrency.toString()]
  ]);

  const timings = { generationMs: 0, submissionMs: 0 };

  const walletsToProcess = [];
  for (const wallet of wallets) {
    const receipts = await loadReceipts(wallet.folder);
    if (!hasReceiptForChallenge(receipts, challengeId)) {
      walletsToProcess.push(wallet);
    }
  }

  if (!walletsToProcess.length) {
    console.log(chalk.green('✓ Nothing to do — every wallet already has a receipt for this challenge.'));
    return {
      results: { success: 0, skipped: wallets.length, failed: 0, validated: 0 },
      timings,
      meta: {
        walletsWithSolutions: wallets.length,
        walletsNeedingGeneration: 0,
        walletsForSubmit: 0,
        walletConcurrency: concurrency,
        totalHashRate: 0,
        avgHashRate: null,
        peakHashRate: null,
        totalHashes: 0,
        didWork: false
      }
    };
  }

  console.log(
    `${chalk.gray('→ pending')} ${chalk.white(walletsToProcess.length)} ${chalk.gray(
      `(${wallets.length - walletsToProcess.length} already solved)`
    )}`
  );

  const challengeMeta = { id: challengeId, day: challengeDay, number: challengeNumber };
  const withSolutionsChecks = await Promise.all(
    walletsToProcess.map(async (wallet) => {
      const sols = await getSolutionFiles(challengeMeta, wallet.address);
      return { wallet, has: sols.length > 0 };
    })
  );
  const walletsWithSolutions = withSolutionsChecks.filter((x) => x.has).map((x) => x.wallet);
  const walletsNeedingGen = withSolutionsChecks.filter((x) => !x.has).map((x) => x.wallet);
  const submitOnly = process.env.AUTOMATE_SUBMIT_ONLY === '1';

  let step1Duration = 0;
  if (!submitOnly && walletsNeedingGen.length > 0) {
    console.log(`\n${chalk.yellow('⛏')} Generating solutions for ${walletsNeedingGen.length} wallet(s)...`);
    const step1StartTime = Date.now();
    const addresses = walletsNeedingGen.map((w) => w.address);
    const batchSolverResult = await runBatchSolver(
      solverBin,
      addresses,
      challenge.path,
      SOLUTIONS_BASE_DIR
    );
    const step1EndTime = Date.now();
    step1Duration = step1EndTime - step1StartTime;
    timings.generationMs = step1Duration;
    if (!batchSolverResult.success) {
      console.error('✖ Batch solver failed during generation. Aborting submissions for this batch.');
      return {
        results: {
          success: 0,
          skipped: walletsNeedingGen.length,
          failed: walletsNeedingGen.length,
          validated: 0
        },
        timings,
        meta: {
          walletsWithSolutions: walletsWithSolutions.length,
          walletsNeedingGeneration: walletsNeedingGen.length,
          walletsForSubmit: walletsWithSolutions.length,
          walletConcurrency: concurrency,
          totalHashRate: 0,
          avgHashRate: null,
          peakHashRate: null,
          totalHashes: 0
        }
      };
    }
    console.log(`${chalk.green('✔')} Generation finished in ${chalk.white(formatDuration(step1Duration))}`);
  } else {
    console.log(
      `\n${chalk.yellow('⛏')} Generation skipped — ${walletsWithSolutions.length} wallet(s) already have cached solutions.`
    );
  }

  const walletsForSubmit =
    walletsWithSolutions.length > 0 || walletsNeedingGen.length > 0
      ? walletsWithSolutions.concat(walletsNeedingGen)
      : walletsToProcess;

  const meta = {
    walletsWithSolutions: walletsWithSolutions.length,
    walletsNeedingGeneration: walletsNeedingGen.length,
    walletsForSubmit: walletsForSubmit.length,
    walletConcurrency: concurrency,
    didWork: true
  };

  console.log(
    `\n${chalk.cyan('🚀')} Submitting ${walletsForSubmit.length} wallet(s) ${chalk.gray(
      `(concurrency ${concurrency})`
    )}`
  );

  const performance = {
    totalHashRate: 0,
    totalHashes: 0,
    countedHashRates: 0,
    peakHashRate: 0
  };

  const step2StartTime = Date.now();
  const results = { success: 0, skipped: 0, failed: 0, validated: 0 };
  const skipReasons = new Map();

  for (let i = 0; i < walletsForSubmit.length; i += concurrency) {
    const batch = walletsForSubmit.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((wallet) => submitWalletSolutions(wallet, challenge)));

    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j];
      const wallet = batch[j];
      const label = shortAddress(wallet.address, 10);

      if (result.success) {
        results.success += 1;
        if (result.validated) results.validated += 1;

        if (Number.isFinite(result.hashRate) && result.hashRate > 0) {
          performance.totalHashRate += result.hashRate;
          performance.countedHashRates += 1;
          performance.peakHashRate = Math.max(performance.peakHashRate, result.hashRate);
        }
        if (Number.isFinite(result.totalHashes)) {
          performance.totalHashes += result.totalHashes;
        }

        const hashRateLabel = formatHashRate(result.hashRate);
        const durationLabel = formatDuration(result.elapsedMs);
        const statusIcon = result.validated ? chalk.green('🏁') : chalk.green('✅');
        console.log(
          `${statusIcon} ${chalk.white(label)} ${chalk.gray(`nonce ${formatNonce(result.nonce)}`)} ${chalk.blue(
            hashRateLabel
          )} ${chalk.gray(durationLabel)}`
        );
      } else if (result.skipped) {
        results.skipped += 1;
        const reason = result.reason || 'unknown';
        skipReasons.set(reason, (skipReasons.get(reason) || 0) + 1);
        console.log(`${chalk.yellow('↺')} ${chalk.white(label)} ${chalk.gray(reason)}`);
        if (Array.isArray(result.errors) && result.errors.length) {
          const lastError = result.errors[result.errors.length - 1];
          const statusLabel = lastError.status
            ? `${lastError.status}${lastError.statusText ? ` ${lastError.statusText}` : ''}`
            : 'n/a';
          console.log(`    ↳ last error: ${statusLabel}${lastError.message ? ` – ${lastError.message}` : ''}`);
        }
      } else {
        results.failed += 1;
        console.error(`${chalk.red('✖')} ${chalk.white(label)} failed to submit (no details).`);
      }
    }

    if (i + concurrency < walletsForSubmit.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  const step2Duration = Date.now() - step2StartTime;
  timings.submissionMs = step2Duration;

  const totalDuration = step1Duration + step2Duration;
  const avgHashRate =
    performance.countedHashRates > 0
      ? performance.totalHashRate / performance.countedHashRates
      : null;

  logSection('Timing', [
    ['Generation', formatDuration(step1Duration)],
    ['Submission', formatDuration(step2Duration)],
    ['Total', formatDuration(totalDuration)]
  ]);

  logSection('Results', [
    ['Wallets processed', meta.walletsForSubmit.toString()],
    ['Validated', `${results.validated}/${results.success}`],
    ['Skipped', results.skipped.toString()],
    ['Failed', results.failed.toString()],
    ['Hashrate (avg)', formatHashRate(avgHashRate)],
    ['Hashrate (peak)', formatHashRate(performance.peakHashRate)],
    ['Hashrate (total)', formatHashRate(performance.totalHashRate)],
    ['Total hashes', performance.totalHashes ? formatNumber(performance.totalHashes) : '–']
  ]);

  if (skipReasons.size > 0) {
    logSection(
      'Skip reasons',
      Array.from(skipReasons.entries()).map(([reason, count]) => [reason, count.toString()])
    );
  }

  return {
    results,
    timings,
    meta: {
      ...meta,
      totalHashRate: performance.totalHashRate,
      avgHashRate: avgHashRate,
      peakHashRate: performance.peakHashRate || null,
      totalHashes: performance.totalHashes
    }
  };
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
  const args = { from: null, to: null, walletConcurrency: null };
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
    } else if (arg === '--wallet-concurrency' || arg === '--walletConcurrency' || arg === '-c') {
      if (i + 1 < argv.length) {
        args.walletConcurrency = parseInt(argv[++i], 10);
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
AshMaize Automation Script

Usage:
  node automate-solver.js [--from INDEX] [--to INDEX] [--wallet-concurrency N]
  node automate-solver.js [START_INDEX] [END_INDEX]

Options:
  --from, -f INDEX    Start processing from wallet index (1-based, inclusive)
  --to, -t INDEX      Stop processing at wallet index (1-based, inclusive)
  --wallet-concurrency, -c N  Submit solutions for up to N wallets simultaneously (default 5)
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
  const resolveConcurrency = () => {
    if (Number.isFinite(args.walletConcurrency) && args.walletConcurrency > 0) {
      return Number(args.walletConcurrency);
    }
    const envValue = process.env.AUTOMATE_WALLET_CONCURRENCY;
    if (envValue !== undefined && envValue !== null) {
      const parsed = Number(envValue);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return 5;
  };
  const walletConcurrency = resolveConcurrency();

  console.log('=== AshMaize Automation Script ===\n');
  console.log(`Started at: ${new Date().toISOString()}\n`);

  // Find batch solver binary
  console.log('Looking for batch solver binary...');
  const solverBin = await findSolverBinary('solve-batch');
  console.log(`Using batch solver: ${solverBin.label}\n`);

  // Ensure directories exist
  await fs.mkdir(SOLUTIONS_BASE_DIR, { recursive: true });

  // Get current challenge
  console.log('Getting current challenge...');
  const challenge = await getCurrentChallenge();
  const resolvedChallengeId =
    challenge.challenge.challenge_id || challenge.challenge.challengeId;
  const resolvedChallengeNumber =
    challenge.challenge.challenge_number ?? challenge.number ?? 'n/a';
  console.log(`Current challenge: ${resolvedChallengeId} (${resolvedChallengeNumber})`);

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
    batchReport = await processWalletsBatch(solverBin, wallets, challenge, walletConcurrency);
  } catch (error) {
    console.error(`Error processing wallets:`, error);
  }

  const reportTimestamp = Math.floor(Date.now() / 1000);
  if (batchReport?.results) {
    const challengeIdentifier =
      challenge.challenge.challenge_id ||
      challenge.challenge.challengeId ||
      (challenge.number !== undefined ? String(challenge.number) : null);

    const didWork = batchReport.meta?.didWork !== false;
    if (didWork) {
      const processedWallets = batchReport.meta?.walletsForSubmit ?? wallets.length;
      const summaryRows = [
        [
          'Challenge',
          `${challengeIdentifier} · Day ${challenge.challenge.day ?? 'n/a'} · #${resolvedChallengeNumber}`
        ],
        ['Wallets processed', processedWallets.toString()],
        ['Validated', `${batchReport.results.validated ?? 0}/${batchReport.results.success ?? 0}`],
        ['Skipped', (batchReport.results.skipped ?? 0).toString()],
        ['Failed', (batchReport.results.failed ?? 0).toString()],
        ['Hashrate (avg)', formatHashRate(batchReport.meta?.avgHashRate)],
        ['Hashrate (peak)', formatHashRate(batchReport.meta?.peakHashRate)],
        ['Hashrate (total)', formatHashRate(batchReport.meta?.totalHashRate)],
        [
          'Total hashes',
          batchReport.meta?.totalHashes ? formatNumber(batchReport.meta.totalHashes) : '–'
        ],
        ['Gen time', formatDuration(batchReport.timings?.generationMs)],
        ['Submit time', formatDuration(batchReport.timings?.submissionMs)]
      ];
      logSection('Run Summary', summaryRows);

      const automationReport = {
        challengeId: challengeIdentifier,
        solutions: {
          succeded: batchReport.results.success ?? 0,
          skipped: batchReport.results.skipped ?? 0,
          failed: batchReport.results.failed ?? 0,
          validated: batchReport.results.validated ?? 0
        },
        timings: {
          generationMs: batchReport.timings?.generationMs ?? 0,
          submissionMs: batchReport.timings?.submissionMs ?? 0
        },
        walletsProcessed: processedWallets,
        timeStamp: reportTimestamp,
        dataDir: process.env.ASHMAIZE_DATA_DIR ?? DATA_FINAL_DIR,
        performance: {
          totalHashRate: batchReport.meta?.totalHashRate ?? null,
          avgHashRate: batchReport.meta?.avgHashRate ?? null,
          peakHashRate: batchReport.meta?.peakHashRate ?? null,
          totalHashes: batchReport.meta?.totalHashes ?? null
        }
      };

      console.log(`AUTOMATE_SOLVER_RESULT ${JSON.stringify(automationReport)}`);
    } else {
      console.log(chalk.gray('No wallet work required for this challenge run.'));
    }
  }

  const endTime = Date.now();
  const duration = endTime - startTime;
  if (batchReport?.meta?.didWork !== false) {
    logSection('Run Timing', [
      ['Finished at', new Date().toISOString()],
      ['Elapsed', formatDuration(duration)]
    ]);
  } else {
    console.log(chalk.gray(`Finished at ${new Date().toISOString()} (${formatDuration(duration)})`));
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

