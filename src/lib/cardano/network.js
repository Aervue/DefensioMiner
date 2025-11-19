import { Cardano } from '@cardano-sdk/core';

const { ChainIds } = Cardano;

const CHAIN_CONFIGS = {
  mainnet: { name: 'mainnet', chainId: ChainIds.Mainnet },
  preprod: { name: 'preprod', chainId: ChainIds.Preprod },
  preview: { name: 'preview', chainId: ChainIds.Preview },
  sanchonet: { name: 'sanchonet', chainId: ChainIds.Sanchonet }
};

export const DEFAULT_CHAIN_NAME = process.env.DEFENSIO_NETWORK?.toLowerCase() ?? 'mainnet';

export const getDefaultChainConfig = () => CHAIN_CONFIGS[DEFAULT_CHAIN_NAME];

export const resolveChainConfig = (name = DEFAULT_CHAIN_NAME) => {
  const resolvedName = name.toLowerCase();
  const config = CHAIN_CONFIGS[resolvedName];
  if (!config) {
    const supported = Object.keys(CHAIN_CONFIGS).join(', ');
    throw new Error(`Unsupported chain name "${name}". Supported chains: ${supported}`);
  }
  return config;
};

export const listSupportedChains = () => Object.values(CHAIN_CONFIGS).map(({ name }) => name);

