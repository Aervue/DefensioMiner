# Defensio Main CLI

Unified automation for wallet lifecycle management (generation → registration → donation) and solver orchestration for `mine.defensio.io`.

---

## Quick Reference (Short Version)

| Step | Command | Notes |
| --- | --- | --- |
| Install deps | `npm install` | Installs Node dependencies. |
| Build solver | `cd solver && cargo build --release` | Requires Rust toolchain. |
| Generate wallets | `npm run generate` | Defaults to 100 wallets, 1 external + 1 internal address each. |
| Register wallets | `npm run register -- --from 1 --to 100` | Creates receipts in `wallets/registered/<id>`. |
| Donate range | `npm run donate -- --from 10 --to 20` | Wallet 10 receives, others donate (2 s delay per donor). |
| Start miner | `ASHMAIZE_THREADS=8 npm run start -- --from 1 --to 100 --batchSize 8 --wallet-concurrency 8` | Polls challenges; spawns solver batches. | (put in ASHMAIZE_THREADS equal to how many threads/cores you want to use from your pc, usually max)

Useful CLI flags:
- `--wallet-root <path>` – change the root wallet directory.
- `--api-base <url>` – override API host (defaults to `https://mine.defensio.io/api`).

---

## Detailed Guide

### 1. Prerequisites

| Requirement | Purpose |
| --- | --- |
| Node.js ≥ 20 | Runs the CLI (`src/cli.js`). |
| npm | Installs JS dependencies. |
| Rust toolchain + cargo | Builds the `solver` binaries. |
| Access to `https://mine.defensio.io/api` | Wallet registration/donation/mining. |

Optional environment overrides:

- `DEFENSIO_WALLET_ROOT` → custom wallets directory (defaults to `<repo>/wallets`).
- `DEFENSIO_API_BASE` → alternate API base; trailing slash removed automatically.
- `DEFENSIO_NETWORK` → default Cardano network (`mainnet`, `preprod`, `preview`, `sanchonet`).

### 2. Project Layout

```
src/
  cli.js           # Command dispatcher
  commands/
    generate.js    # Wallet generation
    register.js    # Registration + receipt handling
    donate.js      # Donation workflow
    start.js       # Miner launcher
  miner/
    poll.js        # Challenge poller / solver batches
    automate-solver.js # Wrapper around Rust solver binaries
solver/            # Rust crate (ashmaize) + binaries
wallets/           # Generated state (ignored in git)
```

Wallet directories:

- `wallets/generated/<id>` – raw generated wallets.
- `wallets/registered/<id>` – registered copies + receipts.
- `wallets/mining/<id>` – copies used by miner automation.
- `wallets/donors/` – per-donor donation logs.

### 3. Installation & Build

```bash
git clone <repo> defensio-main
cd defensio-main

# Install JS dependencies
npm install

# Build solver binaries
cd solver
cargo build --release
cd ..
```

The CLI automatically uses the release binary in `solver/target/release/solve`. Debug builds are used only if release is missing.

### 4. CLI Commands

Run via `node ./src/cli.js <command>` or `npm run <script>`. Use `--` when passing flags through npm.

#### Wallet Generation

```bash
npm run generate -- --count 50 --network mainnet --mnemonic-length 24
```

Key options:
- `--count N` – number of wallets (default 100).
- `--external N`, `--internal N` – number of derived addresses (default 1/1 via npm script).
- `--network <name>` – Cardano network (defaults to env or mainnet).
- `--start-index <id>` – override first wallet ID.

#### Registration

```bash
npm run register -- --from 1 --to 50 --force
```

- Operates on `wallets/generated`.
- Copies wallets into `registered` & `mining`, writes `registration_receipt.json` per folder.
- `--from`/`--to` narrow the ID range.
- `--force` re-registers even if a receipt exists (overwrites receipts).
- Built-in throttle: 2000 ms between API calls.

#### Donation

```bash
npm run donate -- --from 10 --to 20
```

- Filters registered wallets by ID range.
- First wallet in the range is the recipient; others donate sequentially.
- 2000 ms delay between donors to avoid API bursts.
- Logs stored as `wallets/donors/<donorId>.json`.

#### Mining Automation (`start`)

```bash
npm run start -- --from 1 --to 100 --batch 5
```

- Launches `src/miner/poll.js`, which polls `https://mine.defensio.io/api/challenge`.
- For each new challenge it spawns `automate-solver.js` batches.

Flags:

- `--from`, `--to` – specify which wallet IDs to use for mining.
- `--batch` – how many wallets per solver batch (default 1).

Environment variables for solver tuning:

| Variable | Default | Description |
| --- | --- | --- |
| `ASHMAIZE_THREADS` | Physical core count | Number of threads used by the Rust solver. |
| `ASHMAIZE_BATCH_SIZE` | 16 | Salts per worker batch. |
| `ASHMAIZE_FLUSH_INTERVAL` | `batch * 256` | Hash flush interval. |
| `ASHMAIZE_LOG_INTERVAL_MS` | 1000 | Periodic hash-rate logging. |
| `ASHMAIZE_SOLUTIONS_PER_BATCH` | 1 | Solutions per run in single-wallet mode. |

Miner-specific overrides:

- `CHALLENGE_POLL_INTERVAL_MS` – how often to poll the challenge endpoint.
- `FAST_BACKLOG_BLOCK`, `FAST_BACKLOG_TIMEOUT_MS` – backlog submission gating.
- `AUTOMATE_SOLVER_START_INDEX`, `AUTOMATE_SOLVER_END_INDEX`, `AUTOMATE_SOLVER_BATCH_SIZE` – environment-based start overrides.

Diagnostics:

- `DIAGNOSTICS_ENABLED` (default `1`) and `DIAGNOSTICS_BASE_URL` control optional reporting to `https://mine.defensio.io/api/diagnostics`.

### 5. Running End-to-End

1. **Generate wallets** – ensures up-to-date address sets.
2. **Register** – replicate to registered/mining folders and obtain receipts.
3. **Donate (optional)** – consolidate scavenger rights within ID ranges.
4. **Start miner** – poll challenges and submit solver results.

Each step can be repeated with narrower ranges as needed (e.g., re-register a subset with `--from`/`--to`).

### 6. Troubleshooting

- `SyntaxError: Identifier 'fs' has already been declared` – ensure only one import statement per module.
- `fetch failed` in donation logs – indicates an API/network issue; logs remain per donor for retry analysis.
- Missing solver binary – run `cargo build --release` again or delete `solver/target` to rebuild.

Logs and receipts are stored inside the `wallets/` tree, which is git-ignored by default.

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
