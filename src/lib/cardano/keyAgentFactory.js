import { InMemoryKeyAgent, KeyPurpose } from '@cardano-sdk/key-management';
import { SodiumBip32Ed25519 } from '@cardano-sdk/crypto';
import { createLogger } from '../utils/logger.js';

const ensurePassphrase = (passphrase) => {
  const resolved = passphrase ?? '';
  if (typeof resolved !== 'string') {
    throw new Error('Passphrase must be a string');
  }
  return Buffer.from(resolved, 'utf8');
};

const createDependencies = async (namespace) => {
  const bip32Ed25519 = await SodiumBip32Ed25519.create();
  const logger = createLogger(namespace);
  return { bip32Ed25519, logger };
};

export const createKeyAgentFromMnemonic = async ({
  mnemonicWords,
  passphrase,
  chainId,
  accountIndex = 0,
  purpose = KeyPurpose.STANDARD
}) => {
  if (!Array.isArray(mnemonicWords) || mnemonicWords.length === 0) {
    throw new Error('mnemonicWords must be a non-empty string array');
  }
  if (!chainId) {
    throw new Error('chainId is required when creating a key agent');
  }

  const dependencies = await createDependencies('key-agent:create');
  const keyAgent = await InMemoryKeyAgent.fromBip39MnemonicWords(
    {
      mnemonicWords,
      chainId,
      accountIndex,
      purpose,
      getPassphrase: async () => ensurePassphrase(passphrase)
    },
    dependencies
  );

  return keyAgent;
};

export const restoreKeyAgent = async ({ serializedData, passphrase }) => {
  if (!serializedData || serializedData.__typename !== 'InMemory') {
    throw new Error('Only serialized InMemory key agents are supported');
  }
  const dependencies = await createDependencies('key-agent:restore');
  return new InMemoryKeyAgent(
    {
      ...serializedData,
      getPassphrase: async () => ensurePassphrase(passphrase)
    },
    dependencies
  );
};

