import { AddressType } from '@cardano-sdk/key-management';

const ADDRESS_TYPE_LABELS = {
  [AddressType.External]: 'External',
  [AddressType.Internal]: 'Internal'
};

const toPlainAddress = (groupedAddress) => ({
  role: ADDRESS_TYPE_LABELS[groupedAddress.type] ?? 'Unknown',
  index: groupedAddress.index,
  networkId: groupedAddress.networkId,
  paymentAddress: groupedAddress.address,
  rewardAccount: groupedAddress.rewardAccount,
  stakeKeyDerivationPath: groupedAddress.stakeKeyDerivationPath
});

const deriveGroupedAddressesForRole = async (keyAgent, role, count, stakeKeyIndex) => {
  const derived = [];
  for (let index = 0; index < count; index += 1) {
    const groupedAddress = await keyAgent.deriveAddress({ type: role, index }, stakeKeyIndex);
    derived.push(groupedAddress);
  }
  return derived;
};

export const deriveGroupedAddressSet = async (
  keyAgent,
  { externalCount = 10, internalCount = 5, stakeKeyIndex = 0 } = {}
) => {
  const [external, internal] = await Promise.all([
    deriveGroupedAddressesForRole(keyAgent, AddressType.External, externalCount, stakeKeyIndex),
    deriveGroupedAddressesForRole(keyAgent, AddressType.Internal, internalCount, stakeKeyIndex)
  ]);

  return { external, internal };
};

export const deriveAddressSet = async (
  keyAgent,
  { externalCount = 10, internalCount = 5, stakeKeyIndex = 0 } = {}
) => {
  const grouped = await deriveGroupedAddressSet(keyAgent, {
    externalCount,
    internalCount,
    stakeKeyIndex
  });

  return {
    external: grouped.external.map(toPlainAddress),
    internal: grouped.internal.map(toPlainAddress)
  };
};

export const toPlainAddresses = (groupedSet) => ({
  external: groupedSet.external.map(toPlainAddress),
  internal: groupedSet.internal.map(toPlainAddress)
});

