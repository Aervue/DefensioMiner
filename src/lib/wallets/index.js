import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson } from '../utils/files.js';

const WALLET_ID_PATTERN = /^\d+$/;

export const formatWalletId = (value) => String(value).padStart(6, '0');

export const listWalletFolders = async (root) => {
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory() && WALLET_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(a) - Number(b));
};

export const nextWalletId = async (root) => {
  const folders = await listWalletFolders(root);
  if (!folders.length) {
    return 1;
  }
  const max = folders.reduce((acc, folder) => Math.max(acc, Number(folder)), 0);
  return max + 1;
};

export const walletFolderPath = (root, id) => path.join(root, formatWalletId(id));

export const loadWalletJson = async (folderPath) => readJson(path.join(folderPath, 'wallet.json'));

export const saveWalletJson = async (folderPath, payload) => {
  await fs.mkdir(folderPath, { recursive: true });
  await writeJson(path.join(folderPath, 'wallet.json'), payload);
};

export const copyWalletFolder = async (source, target) => {
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(source, target, { recursive: true });
};

export const extractPrimaryAddress = (walletJson) => {
  const externalEntry = walletJson?.wallet?.addresses?.external?.[0];
  if (!externalEntry) {
    return null;
  }
  return externalEntry.paymentAddress ?? externalEntry.address ?? null;
};

export const normalizeMnemonicWords = (value) => {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    return value
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }
  throw new Error('Unable to determine mnemonic words for wallet.');
};

export const loadWallFile = async (filePath) => (await readJson(filePath, [])) ?? [];

export const upsertWallEntry = async (filePath, entry) => {
  const wall = await loadWallFile(filePath);
  const index = wall.findIndex(
    (item) => item.id === entry.id || item.directory === entry.directory || item.address === entry.address
  );
  if (index >= 0) {
    wall[index] = entry;
  } else {
    wall.push(entry);
  }
  await writeJson(filePath, wall);
  return wall;
};

