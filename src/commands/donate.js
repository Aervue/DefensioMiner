import fs from 'node:fs/promises';
import path from 'node:path';
import { apiEndpoints } from '../config/index.js';
import { createKeyAgentFromMnemonic } from '../lib/cardano/keyAgentFactory.js';
import { deriveGroupedAddressSet } from '../lib/cardano/addressManager.js';
import {
  listWalletFolders,
  walletFolderPath,
  loadWalletJson,
  extractPrimaryAddress,
  normalizeMnemonicWords,
  formatWalletId
} from '../lib/wallets/index.js';

const toHex = (value) => Buffer.from(value, 'utf8').toString('hex');

const ensureDir = async (dirPath) => fs.mkdir(dirPath, { recursive: true });

const DONATION_DELAY_MS = 2000;

const deriveKnownAddresses = async (keyAgent, walletJson) => {
  const stakeKeyIndex = walletJson.meta?.stakeKeyIndex ?? 0;
  const externalCount =
    walletJson.meta?.externalCount ?? walletJson.wallet?.addresses?.external?.length ?? 1;
  const internalCount =
    walletJson.meta?.internalCount ?? walletJson.wallet?.addresses?.internal?.length ?? 1;
  const groupedAddresses = await deriveGroupedAddressSet(keyAgent, {
    externalCount,
    internalCount,
    stakeKeyIndex
  });
  return [
    ...(groupedAddresses.external ?? []),
    ...(groupedAddresses.internal ?? [])
  ];
};

const signDonationMessage = async ({
  donorAddress,
  recipientAddress,
  walletJson,
  mnemonicWords,
  passphrase
}) => {
  const chainId = walletJson.wallet?.chainId;
  if (!chainId) {
    throw new Error('Wallet chainId missing.');
  }
  const accountIndex = walletJson.wallet?.serializableData?.accountIndex ?? 0;
  const keyAgent = await createKeyAgentFromMnemonic({
    mnemonicWords,
    passphrase,
    chainId,
    accountIndex
  });
  const knownAddresses = await deriveKnownAddresses(keyAgent, walletJson);
  const message = `Assign accumulated Scavenger rights to: ${recipientAddress}`;
  const signature = await keyAgent.signCip8Data({
    signWith: donorAddress,
    payload: toHex(message),
    knownAddresses
  });
  return { message, signature };
};

const donateOnce = async ({
  recipientAddress,
  donorAddress,
  walletJson,
  mnemonicWords,
  passphrase
}) => {
  const { signature } = await signDonationMessage({
    donorAddress,
    recipientAddress,
    walletJson,
    mnemonicWords,
    passphrase
  });
  const url = [
    apiEndpoints.donateTo(),
    encodeURIComponent(recipientAddress),
    encodeURIComponent(donorAddress),
    encodeURIComponent(signature.signature)
  ].join('/');

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' }
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (response.status === 409) {
    return { outcome: 'already-consolidated', payload: data };
  }

  if (!response.ok || data?.status !== 'success') {
    const message = typeof data === 'object' ? JSON.stringify(data) : text;
    throw new Error(`Donation failed (${response.status}): ${message}`);
  }

  return { outcome: 'success', payload: data };
};

export const runDonate = async (args, { paths }) => {
  const walletIds = await listWalletFolders(paths.registeredRoot);
  if (!walletIds.length) {
    console.log('No registered wallets found. Run `defensio register` first.');
    return;
  }

  const from = args.from ? Number(args.from) : null;
  const to = args.to ? Number(args.to) : null;

  const selected = walletIds.filter((id) => {
    const numeric = Number(id);
    if (Number.isNaN(numeric)) return false;
    if (from !== null && numeric < from) return false;
    if (to !== null && numeric > to) return false;
    return true;
  });

  if (selected.length < 2) {
    console.log('Need at least two wallets in the specified range to perform donations.');
    return;
  }

  const rangeStart = Number(selected[0]);
  const rangeEnd = Number(selected[selected.length - 1]);
  const recipientId = rangeStart;
  const donorIds = selected.slice(1).map(Number);

  const recipientFolder = walletFolderPath(paths.registeredRoot, recipientId);
  const recipientWallet = await loadWalletJson(recipientFolder);
  const recipientAddress = extractPrimaryAddress(recipientWallet);
  if (!recipientAddress) {
    console.warn(`Recipient wallet ${formatWalletId(recipientId)} missing address; aborting donations.`);
    return;
  }

  console.log(
    `Donating from ${donorIds.length} wallet(s) in range ${formatWalletId(rangeStart)}-${formatWalletId(
      rangeEnd
    )} to ${formatWalletId(recipientId)} (${recipientAddress.slice(0, 32)}...)`
  );

  for (const donorId of donorIds) {
    if (DONATION_DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, DONATION_DELAY_MS));
    }

    const donorFolder = walletFolderPath(paths.registeredRoot, donorId);
    const walletJson = await loadWalletJson(donorFolder);
    if (!walletJson) {
      console.warn(`Wallet ${formatWalletId(donorId)} missing wallet.json; skipping.`);
      continue;
    }
    const donorAddress = extractPrimaryAddress(walletJson);
    if (!donorAddress) {
      console.warn(`Wallet ${formatWalletId(donorId)} missing address; skipping.`);
      continue;
    }
    const mnemonicWords = normalizeMnemonicWords(walletJson.mnemonic);
    const passphrase = walletJson.passphrase ?? walletJson.meta?.passphrase ?? '';
    const recordPath = path.join(paths.donorRoot, `${formatWalletId(donorId)}.json`);

    try {
      await ensureDir(path.dirname(recordPath));
      const result = await donateOnce({
        recipientAddress,
        donorAddress,
        walletJson,
        mnemonicWords,
        passphrase
      });
      await fs.writeFile(
        recordPath,
        `${JSON.stringify(
          {
            executedAt: new Date().toISOString(),
            from: formatWalletId(rangeStart),
            to: formatWalletId(rangeEnd),
            donorId,
            donorAddress,
            recipientId,
            recipientAddress,
            outcome: result.outcome,
            response: result.payload
          },
          null,
          2
        )}\n`,
        'utf8'
      );
      console.log(`Donor ${formatWalletId(donorId)} -> ${result.outcome.toUpperCase()}`);
    } catch (error) {
      console.error(`Donor ${formatWalletId(donorId)} failed: ${error.message}`);
    }
  }
};
