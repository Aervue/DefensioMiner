#!/usr/bin/env node

import { ensureDefaultStructure } from './config/index.js';
import { parseArgs } from './lib/utils/args.js';
import { runGenerate } from './commands/generate.js';
import { runRegister } from './commands/register.js';
import { runDonate } from './commands/donate.js';
import { runStart } from './commands/start.js';

const printHelp = () => {
  console.log(`
Defensio Main CLI

Usage: defensio <command> [options]

Commands:
  generate    Generate new wallets under wallets/generated
  register    Register generated wallets at mine.defensio.io
  donate      Donate scavenger rights between wallets
  start       Start polling + solver automation

Global options:
  --wallet-root <path>   Override default wallets directory
  --api-base <url>       Override default API base (https://mine.defensio.io/api)
`);
};

const main = async () => {
  const [, , rawCommand, ...rest] = process.argv;
  const command = rawCommand ?? 'help';
  const args = parseArgs(rest);

  if (args['wallet-root']) {
    process.env.DEFENSIO_WALLET_ROOT = args['wallet-root'];
  }

  if (args['api-base']) {
    process.env.DEFENSIO_API_BASE = args['api-base'];
  }

  const paths = await ensureDefaultStructure();
  const context = { paths, args };

  switch (command) {
    case 'generate':
      await runGenerate(args, context);
      break;
    case 'register':
      await runRegister(args, context);
      break;
    case 'donate':
      await runDonate(args, context);
      break;
    case 'start':
      await runStart(args, context);
      break;
    default:
      printHelp();
      break;
  }
};

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exitCode = 1;
});

