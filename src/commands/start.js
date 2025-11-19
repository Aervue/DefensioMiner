import { startPoller } from '../miner/poll.js';

export const runStart = async (args, { paths }) => {
  await startPoller({
    paths,
    startIndex: args.from ? Number(args.from) : undefined,
    endIndex: args.to ? Number(args.to) : undefined,
    batchSize: args.batch ? Number(args.batch) : undefined
  });
};

