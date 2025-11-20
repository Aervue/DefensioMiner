# Defensio Main CLI

Unified automation for wallet lifecycle management (generation → registration → donation) and solver orchestration for `mine.defensio.io`.

---

## Quick Reference (Short Version)

| Step | Command | Notes |
| --- | --- | --- |
| Install deps | `npm install` | Installs Node dependencies. |
| Build solver | `npm run build:solver` | auto-tunes `RUSTFLAGS` per CPU. |
| Generate wallets | `npm run generate` | Defaults to 100 wallets, 1 external + 1 internal address each. |
| Register wallets | `npm run register -- --from 1 --to 100` | Creates receipts in `wallets/registered/<id>`. |
| Donate range | `npm run donate -- --from 10 --to 20` | Wallet 10 receives, others donate (2 s delay per donor). |
| Start miner | `ASHMAIZE_THREADS=8 npm run start -- --from 1 --to 100 --batch 8 --wallet-concurrency 8` | Polls challenges; spawns solver batches. | (ASHMAIZE_THREADS = physical cores/threads you want to use)

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
- `TARGET_FEATURES` → overrides auto-detected `-C target-feature` when building the solver.

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

# Build solver binaries (auto-optimized for your CPU)
npm run build:solver

# (optional) Traditional build
cd solver && cargo build --release && cd ..
```

`npm run build:solver` wraps `cargo build --release` with CPU-specific `RUSTFLAGS`:

- `-C target-cpu=native` plus `target-feature` bundles tuned for each platform:
  - x86_64: AES/SSE2+/AVX/AVX2/FMA
  - ia32: MMX/SSE through SSE4.2
  - ARM/ARM64: NEON + crypto/CRC/dotprod/FP16 where available
  - RISC-V (riscv64): MAFD + Zba/Zbb/Zbc extensions
- `-C llvm-args=--inline-threshold=1000`, `-C prefer-dynamic=no`, and `-C link-arg=-s` (non-Windows) to keep binaries small and fast.

To experiment with different instruction sets, override via `TARGET_FEATURES="+avx512f,+vpclmulqdq"` (comma separated). Unsupported flags (e.g., link stripping on Windows) are skipped automatically. If you prefer manual control, run the plain cargo command instead.

The CLI automatically uses the release binary in `solver/target/release/solve`. Debug builds are used only if release is missing.

### 4. CLI Commands

Run via `node ./src/cli.js <command>` or `npm run <script>`. Use `--` when passing flags through npm.

Global CLI flags (available on every subcommand):

- `--wallet-root <path>` – override where generated/registered/mining wallets live (defaults to `wallets/`).
- `--api-base <url>` – point at a different API endpoint (defaults to `https://mine.defensio.io/api`).
- `--network <name>` – override Cardano network (`mainnet`, `preprod`, `preview`, `sanchonet`).

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
npm run donate -- --from 10 --to 20 --address addr1q...
```

- Filters registered wallets by ID range.
- Default behavior: first wallet in the range is the recipient; others donate sequentially.
- Pass `--address <paymentAddress>` to donate the entire range directly to an external recipient instead.
- 2000 ms delay between donors to avoid API bursts.
- Logs stored as `wallets/donors/<donorId>.json`.

#### Mining Automation (`start`)

```bash
npm run start -- --from 1 --to 100 --batch 5 --wallet-concurrency 5
```

- Launches `src/miner/poll.js`, which polls `https://mine.defensio.io/api/challenge`.
- For each new challenge it spawns `automate-solver.js` batches.

Flags:

- `--from`, `--to` – wallet ID range for mining.
- `--batch` (`--batchSize`) – wallets per solver batch (default `1`). Larger values keep more wallets busy but increase per-run memory requirements.
- `--wallet-concurrency` – how many wallets `automate-solver` should submit in parallel inside each batch (default `5`). This controls HTTP submission fan-out; keep it aligned with your API limits.
- `--challenge` – pass a cached challenge JSON path to replay submissions manually.
- `--help` – prints command usage.

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
- `AUTOMATE_WALLET_CONCURRENCY` – sets a default for `--wallet-concurrency` so you don’t have to pass it each time.
- `AUTOMATE_SOLVER_RAW_LOGS=1` – emits the raw `solve-batch` stdout/stderr for debugging.
- `AUTOMATE_SUBMIT_ONLY=1` – skips solution generation and only re-submits cached solutions.

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
