import path from 'node:path';
import { createMnemonic, mnemonicToWords, validateMnemonicWords } from '../lib/cardano/mnemonic.js';
import { createKeyAgentFromMnemonic } from '../lib/cardano/keyAgentFactory.js';
import { deriveGroupedAddressSet, toPlainAddresses } from '../lib/cardano/addressManager.js';
import { resolveChainConfig, DEFAULT_CHAIN_NAME } from '../lib/cardano/network.js';
import {
  nextWalletId,
  walletFolderPath,
  saveWalletJson,
  formatWalletId
} from '../lib/wallets/index.js';

const normalizeMnemonicWords = (config) => {
  if (config.mnemonicWords) {
    const words = Array.isArray(config.mnemonicWords)
      ? config.mnemonicWords
      : String(config.mnemonicWords).trim().split(/\s+/);
    if (!validateMnemonicWords(words)) {
      throw new Error('Invalid mnemonicWords provided.');
    }
    return words;
  }

  if (config.mnemonic) {
    const words = mnemonicToWords(config.mnemonic);
    if (!validateMnemonicWords(words)) {
      throw new Error('Invalid mnemonic provided.');
    }
    return words;
  }

  return createMnemonic(config.mnemonicLength ?? 24);
};

const buildWalletPayload = async (config) => {
  const chainConfig = resolveChainConfig(config.network ?? DEFAULT_CHAIN_NAME);
  const passphrase = config.passphrase ?? '';
  const mnemonicWords = normalizeMnemonicWords(config);
  const keyAgent = await createKeyAgentFromMnemonic({
    mnemonicWords,
    passphrase,
    chainId: chainConfig.chainId,
    accountIndex: config.accountIndex ?? 0
  });

  const groupedAddresses = await deriveGroupedAddressSet(keyAgent, {
    externalCount: config.externalCount ?? 10,
    internalCount: config.internalCount ?? 5,
    stakeKeyIndex: config.stakeKeyIndex ?? 0
  });
  const addresses = toPlainAddresses(groupedAddresses);

  const meta = {
    createdAt: new Date().toISOString(),
    mnemonicLength: mnemonicWords.length,
    network: chainConfig.name,
    accountIndex: keyAgent.accountIndex,
    stakeKeyIndex: config.stakeKeyIndex ?? 0,
    externalCount: addresses.external.length,
    internalCount: addresses.internal.length,
    passphrase
  };

  return {
    meta,
    mnemonic: mnemonicWords,
    passphrase,
    wallet: {
      chainId: chainConfig.chainId,
      serializableData: keyAgent.serializableData,
      extendedAccountPublicKey: keyAgent.extendedAccountPublicKey,
      addresses
    }
  };
};

export const runGenerate = async (args, { paths }) => {
  const count = Number(args.count ?? 1);
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error('count must be a positive integer');
  }

  const mnemonicLength = Number(args['mnemonic-length'] ?? 24);
  const externalCount = Number(args.external ?? 10);
  const internalCount = Number(args.internal ?? 5);
  const passphrase = args.passphrase ?? '';
  const startIndexOverride = args['start-index'] ? Number(args['start-index']) : null;

  let nextId = startIndexOverride ?? (await nextWalletId(paths.generatedRoot));

  console.log(
    `Generating ${count} wallet(s) to ${paths.generatedRoot} (mnemonic=${mnemonicLength}, external=${externalCount}, internal=${internalCount})`
  );

  for (let i = 0; i < count; i += 1) {
    const walletId = nextId + i;
    const folderPath = walletFolderPath(paths.generatedRoot, walletId);
    const walletPayload = await buildWalletPayload({
      mnemonicLength,
      externalCount,
      internalCount,
      passphrase,
      network: args.network ?? DEFAULT_CHAIN_NAME
    });
    await saveWalletJson(folderPath, walletPayload);
    console.log(`Saved wallet ${formatWalletId(walletId)} → ${path.relative(paths.walletRoot, folderPath)}`);
  }
};

