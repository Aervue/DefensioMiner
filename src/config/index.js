import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export const API_BASE = process.env.DEFENSIO_API_BASE?.replace(/\/$/, '') ?? 'https://mine.defensio.io/api';

export const resolvePaths = () => {
  const walletRoot = process.env.DEFENSIO_WALLET_ROOT
    ? path.resolve(process.env.DEFENSIO_WALLET_ROOT)
    : path.join(PROJECT_ROOT, 'wallets');

  const paths = {
    projectRoot: PROJECT_ROOT,
    walletRoot,
    generatedRoot: path.join(walletRoot, 'generated'),
    registeredRoot: path.join(walletRoot, 'registered'),
    donorRoot: path.join(walletRoot, 'donors'),
    miningRoot: path.join(walletRoot, 'mining'),
    solutionsRoot: path.join(walletRoot, 'solutions'),
    challengeCache: path.join(walletRoot, 'challenges'),
    receiptsRoot: path.join(walletRoot, 'receipts'),
    wallFile: path.join(walletRoot, 'wall.json')
  };

  return paths;
};

export const ensureDirectory = async (targetPath) => {
  await fs.mkdir(targetPath, { recursive: true });
};

export const ensureDefaultStructure = async () => {
  const paths = resolvePaths();
  await Promise.all([
    ensureDirectory(paths.walletRoot),
    ensureDirectory(paths.generatedRoot),
    ensureDirectory(paths.registeredRoot),
    ensureDirectory(paths.donorRoot),
    ensureDirectory(paths.miningRoot),
    ensureDirectory(paths.solutionsRoot),
    ensureDirectory(paths.challengeCache),
    ensureDirectory(paths.receiptsRoot)
  ]);
  return paths;
};

export const apiEndpoints = {
  register: () => `${API_BASE}/register`,
  donateTo: () => `${API_BASE}/donate_to`,
  challenge: () => `${API_BASE}/challenge`,
  solution: () => `${API_BASE}/solution`
};

