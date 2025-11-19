import fs from 'node:fs/promises';
import path from 'node:path';
import { apiEndpoints } from '../config/index.js';
import { createKeyAgentFromMnemonic } from '../lib/cardano/keyAgentFactory.js';
import { deriveGroupedAddressSet } from '../lib/cardano/addressManager.js';
import { readJson, writeJson } from '../lib/utils/files.js';
import {
  listWalletFolders,
  walletFolderPath,
  loadWalletJson,
  copyWalletFolder,
  extractPrimaryAddress,
  normalizeMnemonicWords,
  upsertWallEntry,
  formatWalletId
} from '../lib/wallets/index.js';

const REGISTRATION_DELAY_MS = 2000;

const REGISTER_MESSAGE =
  'I agree to abide by the terms and conditions as described in version 1-0 of the Defensio DFO mining process: 2da58cd94d6ccf3d933c4a55ebc720ba03b829b84033b4844aafc36828477cc0';
const REGISTRATION_HASH = '2da58cd94d6ccf3d933c4a55ebc720ba03b829b84033b4844aafc36828477cc0';
const REGISTRATION_VERSION = '1-0';

const toHex = (value) => Buffer.from(value, 'utf8').toString('hex');

const deriveNonceFromSignatureKey = (key) => {
  const hex = key.startsWith('0x') ? key.slice(2) : key;
  if (hex.length < 64) {
    throw new Error('Signature key is shorter than 64 hex characters; cannot derive nonce.');
  }
  return hex.slice(-64);
};

const ensureReceipt = async (folderPath) => {
  const receiptPath = path.join(folderPath, 'registration_receipt.json');
  return { receiptPath, existing: await readJson(receiptPath, null) };
};

const buildReceiptRecord = (walletAddress, signature, parsedResponse, responseTimestamp) => {
  const publicKey = (() => {
    const hex = signature.key.startsWith('0x') ? signature.key.slice(2) : signature.key;
    if (hex.length < 64) return null;
    return hex.slice(-64);
  })();

  const derivedPreimage =
    parsedResponse?.preimage ?? `${walletAddress}${signature.signature}${publicKey ?? ''}`;
  const registrationReceipt = parsedResponse?.registrationReceipt ?? null;

  const record = {
    preimage: derivedPreimage,
    timestamp: parsedResponse?.timestamp ?? responseTimestamp,
    walletAddress,
    signature: signature.signature,
    publicKey,
    hash: REGISTRATION_HASH,
    version: REGISTRATION_VERSION,
    serverSignature: registrationReceipt?.signature ?? null,
    registrationReceipt: registrationReceipt
      ? {
          preimage: registrationReceipt.preimage ?? derivedPreimage,
          signature: registrationReceipt.signature ?? null,
          timestamp: registrationReceipt.timestamp ?? responseTimestamp
        }
      : {
          preimage: derivedPreimage,
          signature: null,
          timestamp: responseTimestamp
        }
  };

  return record;
};

const registerWallet = async (id, folderPath, paths) => {
  const walletJson = await loadWalletJson(folderPath);
  if (!walletJson) {
    throw new Error('wallet.json not found.');
  }
  const walletAddress = extractPrimaryAddress(walletJson);
  if (!walletAddress) {
    throw new Error('Wallet does not contain an external payment address.');
  }
  const mnemonicWords = normalizeMnemonicWords(walletJson.mnemonic);
  const passphrase = walletJson.passphrase ?? walletJson.meta?.passphrase ?? '';
  const chainId = walletJson.wallet?.chainId;
  if (!chainId) {
    throw new Error('Wallet chainId missing.');
  }
  const accountIndex = walletJson.wallet?.serializableData?.accountIndex ?? 0;
  const stakeKeyIndex = walletJson.meta?.stakeKeyIndex ?? 0;
  const externalCount =
    walletJson.meta?.externalCount ?? walletJson.wallet?.addresses?.external?.length ?? 1;
  const internalCount =
    walletJson.meta?.internalCount ?? walletJson.wallet?.addresses?.internal?.length ?? 1;

  const keyAgent = await createKeyAgentFromMnemonic({
    mnemonicWords,
    passphrase,
    chainId,
    accountIndex
  });

  const groupedAddresses = await deriveGroupedAddressSet(keyAgent, {
    externalCount,
    internalCount,
    stakeKeyIndex
  });

  const knownAddresses = [
    ...(groupedAddresses.external ?? []),
    ...(groupedAddresses.internal ?? [])
  ];

  const signature = await keyAgent.signCip8Data({
    signWith: walletAddress,
    payload: toHex(REGISTER_MESSAGE),
    knownAddresses
  });

  const nonce = deriveNonceFromSignatureKey(signature.key);
  const url = [
    apiEndpoints.register(),
    encodeURIComponent(walletAddress),
    encodeURIComponent(signature.signature),
    encodeURIComponent(nonce)
  ].join('/');

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' }
  });
  const responseTimestamp = new Date().toISOString();
  const rawText = await response.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = rawText;
  }

  if (!response.ok) {
    const message = typeof data === 'object' ? JSON.stringify(data) : rawText;
    throw new Error(`Register failed (${response.status}): ${message}`);
  }

  const receiptRecord = buildReceiptRecord(walletAddress, signature, data, responseTimestamp);

  const registeredFolder = walletFolderPath(paths.registeredRoot, id);
  await copyWalletFolder(folderPath, registeredFolder);
  await writeJson(path.join(registeredFolder, 'registration_receipt.json'), receiptRecord);
  await fs.rm(path.join(registeredFolder, 'registration_receipt.error.json'), { force: true });

  const miningFolder = walletFolderPath(paths.miningRoot, id);
  await copyWalletFolder(folderPath, miningFolder);
  await writeJson(path.join(miningFolder, 'registration_receipt.json'), receiptRecord);
  await fs.rm(path.join(miningFolder, 'registration_receipt.error.json'), { force: true });

  await upsertWallEntry(paths.wallFile, {
    id: Number(id),
    directory: path.relative(paths.walletRoot, registeredFolder),
    address: walletAddress,
    mnemonic: Array.isArray(walletJson.mnemonic)
      ? walletJson.mnemonic.join(' ')
      : walletJson.mnemonic
  });

  console.log(`Registered wallet ${formatWalletId(id)} (${walletAddress.slice(0, 32)}...)`);
};

export const runRegister = async (args, { paths }) => {
  const walletIds = await listWalletFolders(paths.generatedRoot);
  if (!walletIds.length) {
    console.log('No generated wallets found. Run `defensio generate` first.');
    return;
  }

  const from = args.from ? Number(args.from) : null;
  const to = args.to ? Number(args.to) : null;

  const selected = walletIds.filter((id) => {
    const numeric = Number(id);
    if (from !== null && numeric < from) return false;
    if (to !== null && numeric > to) return false;
    return true;
  });

  if (!selected.length) {
    console.log('No wallets matched the requested range.');
    return;
  }

  const force = args.force === true || args.force === 'true';

  for (const id of selected) {
    const folderPath = walletFolderPath(paths.generatedRoot, Number(id));
    const registeredFolder = walletFolderPath(paths.registeredRoot, Number(id));
    const { receiptPath, existing } = await ensureReceipt(registeredFolder);
    if (existing && !force) {
      console.log(`Skipping wallet ${formatWalletId(id)} (already has registration receipt).`);
      continue;
    }

    if (REGISTRATION_DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, REGISTRATION_DELAY_MS));
    }

    try {
      await registerWallet(Number(id), folderPath, paths);
    } catch (error) {
      console.error(`Failed to register wallet ${formatWalletId(id)}:`, error.message);
      await writeJson(receiptPath.replace(/\.json$/, '.error.json'), {
        at: new Date().toISOString(),
        message: error.message
      });
    }
  }
};
