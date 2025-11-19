import { util as keyManagementUtil } from '@cardano-sdk/key-management';

const MNEMONIC_STRENGTH = {
  12: 128,
  15: 160,
  18: 192,
  21: 224,
  24: 256
};

export const createMnemonic = (wordCount = 24) => {
  const strength = MNEMONIC_STRENGTH[wordCount];
  if (!strength) {
    const supported = Object.keys(MNEMONIC_STRENGTH).join(', ');
    throw new Error(`Unsupported mnemonic length "${wordCount}". Supported lengths: ${supported}`);
  }
  return keyManagementUtil.generateMnemonicWords(strength);
};

export const wordsToMnemonic = (words) => keyManagementUtil.joinMnemonicWords(words);

export const mnemonicToWords = (mnemonic) => keyManagementUtil.mnemonicToWords(mnemonic);

export const validateMnemonicWords = (words) =>
  keyManagementUtil.validateMnemonic(keyManagementUtil.joinMnemonicWords(words));

