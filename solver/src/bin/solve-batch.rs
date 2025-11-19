use std::{
    env, fs,
    num::ParseIntError,
    path::{Path, PathBuf},
    process,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use ashmaize::{Rom, RomGenerationType, hash};
use dashmap::DashMap;
use num_cpus;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
struct Challenge {
    challenge_id: String,
    challenge_number: u64,
    day: u64,
    issued_at: String,
    latest_submission: String,
    difficulty: String,
    #[serde(rename = "no_pre_mine")]
    rom_key_hex: String,
    #[serde(rename = "no_pre_mine_hour")]
    nonce_prefix: String,
}

impl Challenge {
    fn difficulty_target(&self) -> Result<u32, ParseIntError> {
        parse_difficulty(&self.difficulty)
    }

    fn nonce_prefix_u128(&self) -> Result<u128, ParseIntError> {
        Ok(self.nonce_prefix.parse::<u64>()? as u128)
    }
}

#[derive(Clone, Serialize)]
struct SolverParameters {
    rom_size: usize,
    pre_size: usize,
    mixing_numbers: usize,
    nb_loops: u32,
    nb_instrs: u32,
    threads: usize,
    batch_size: usize,
    flush_interval: u64,
    log_interval_ms: u64,
    suffix_offset: u128,
    suffix_stride: u128,
    solutions_per_batch: usize,
}

impl SolverParameters {
    fn from_env() -> Self {
        let default_threads = env_usize("ASHMAIZE_THREADS", num_cpus::get_physical()).max(1);
        let batch_size = env_usize("ASHMAIZE_BATCH_SIZE", 16).max(1);
        let flush_interval = env_u64(
            "ASHMAIZE_FLUSH_INTERVAL",
            (batch_size as u64).saturating_mul(256),
        )
        .max(batch_size as u64);
        let log_interval_ms = env_u64("ASHMAIZE_LOG_INTERVAL_MS", 1_000);
        let suffix_offset = env_u128("ASHMAIZE_SUFFIX_OFFSET", 0);
        let suffix_stride = env_u128("ASHMAIZE_SUFFIX_STRIDE", 1).max(1);
        let solutions_per_batch = env_usize("ASHMAIZE_SOLUTIONS_PER_BATCH", 1).max(1);
        Self {
            rom_size: env_usize("ASHMAIZE_ROM_SIZE", 1 * 1024 * 1024 * 1024),
            pre_size: env_usize("ASHMAIZE_PRE_SIZE", 16 * 1024 * 1024),
            mixing_numbers: env_usize("ASHMAIZE_MIXING_NUMBERS", 4),
            nb_loops: env_u32("ASHMAIZE_NB_LOOPS", 8),
            nb_instrs: env_u32("ASHMAIZE_NB_INSTRS", 256),
            threads: default_threads,
            batch_size,
            flush_interval,
            log_interval_ms,
            suffix_offset,
            suffix_stride,
            solutions_per_batch,
        }
    }
}

#[derive(Debug)]
struct SolveOutcome {
    nonce: u128,
    digest: [u8; 64],
    hashes: u128,
    elapsed: Duration,
    rom_digest: [u8; 64],
    started_at: SystemTime,
    finished_at: SystemTime,
    batch_index: usize,
}

struct SolveState {
    outcomes: Vec<SolveOutcome>,
    next_suffix: u128,
}

struct FoundSolution {
    nonce: u128,
    digest: [u8; 64],
    elapsed: Duration,
    total_hashes: u128,
}

// Global ROM cache
type RomCacheKey = String;
static ROM_CACHE: OnceLock<DashMap<RomCacheKey, Arc<Rom>>> = OnceLock::new();

fn get_rom_cache() -> &'static DashMap<RomCacheKey, Arc<Rom>> {
    ROM_CACHE.get_or_init(|| DashMap::new())
}

fn get_rom_cache_key(challenge: &Challenge, params: &SolverParameters) -> String {
    format!(
        "{}:{}:{}:{}",
        challenge.rom_key_hex, params.rom_size, params.pre_size, params.mixing_numbers
    )
}

fn get_or_build_rom(
    challenge: &Challenge,
    params: &SolverParameters,
) -> Result<Arc<Rom>, Box<dyn std::error::Error>> {
    let cache_key = get_rom_cache_key(challenge, params);
    let cache = get_rom_cache();

    if let Some(cached_rom) = cache.get(&cache_key) {
        println!(
            "Using cached ROM for challenge {}",
            challenge.challenge_number
        );
        return Ok(Arc::clone(cached_rom.value()));
    }

    println!(
        "Building ROM for challenge {} (will be cached)",
        challenge.challenge_number
    );
    let rom_arc = build_rom(challenge, params)?;

    if let Some(cached_rom) = cache.get(&cache_key) {
        println!(
            "Another thread cached ROM for challenge {} while building; reusing cached instance",
            challenge.challenge_number
        );
        return Ok(Arc::clone(cached_rom.value()));
    }

    cache.insert(cache_key, Arc::clone(&rom_arc));

    Ok(rom_arc)
}

fn main() {
    if let Err(err) = run() {
        eprintln!("error: {err}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    let mut solver_params = SolverParameters::from_env();
    
    // Parse addresses from --addresses flag (file or comma-separated)
    let addresses: Vec<String> = if let Some(idx) = args.iter().position(|a| a == "--addresses") {
        if idx + 1 < args.len() {
            let arg_value = &args[idx + 1];
            let path = PathBuf::from(arg_value);
            if path.is_file() {
                let content = fs::read_to_string(&path)?;
                content.lines()
                    .map(|line| line.trim().to_string())
                    .filter(|line| !line.is_empty())
                    .collect()
            } else {
                arg_value.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            }
        } else {
            return Err("--addresses requires a value".into());
        }
    } else {
        return Err("--addresses flag is required".into());
    };

    // Parse solutions directory from --solutions-dir or use default
    let solutions_dir = if let Some(idx) = args.iter().position(|a| a == "--solutions-dir") {
        if idx + 1 < args.len() {
            PathBuf::from(&args[idx + 1])
        } else {
            return Err("--solutions-dir requires a value".into());
        }
    } else {
        env::var("ASHMAIZE_SOLUTIONS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("solutions"))
    };

    // Parse solutions per wallet (default 1)
    let solutions_per_wallet = env_usize("ASHMAIZE_SOLUTIONS_PER_WALLET", 1).max(1);
    solver_params.solutions_per_batch = solutions_per_wallet;

    // Parse wallet concurrency (how many wallets to solve in parallel)
    let wallet_concurrency = if let Some(idx) = args.iter().position(|a| a == "--wallet-concurrency") {
        if idx + 1 < args.len() {
            args[idx + 1].parse::<usize>().unwrap_or(1)
        } else { 1 }
    } else {
        env_usize("ASHMAIZE_WALLET_CONCURRENCY", 1)
    }.max(1);

    // Parse challenge path (last positional argument)
    let path_args: Vec<&String> = args.iter()
        .enumerate()
        .filter_map(|(i, arg)| {
            if arg == "--addresses" || arg == "--solutions-dir" ||
               (i > 0 && (args[i-1] == "--addresses" || args[i-1] == "--solutions-dir")) {
                None
            } else {
                Some(arg)
            }
        })
        .collect();

    if path_args.is_empty() {
        return Err("Challenge file path is required".into());
    }

    let challenge_path = PathBuf::from(path_args[0]);
    if !challenge_path.is_file() {
        return Err(format!("Challenge file '{}' does not exist", challenge_path.display()).into());
    }

    println!("Batch solving for {} wallet(s)", addresses.len());
    println!("Solutions per wallet: {}", solutions_per_wallet);
    println!("Solutions directory: {}", solutions_dir.display());
    
    let challenge = load_challenge(&challenge_path)?;
    let rom = get_or_build_rom(&challenge, &solver_params)?;
    
    fs::create_dir_all(&solutions_dir)?;

    // Aggregate perf across all wallets in this batch
    let total_wallets = addresses.len();
    let batch_start = Instant::now();
    let mut batch_total_hashes: u128 = 0;

    if wallet_concurrency <= 1 {
        // Process each wallet sequentially - each wallet uses all available threads
        for (idx, address) in addresses.iter().enumerate() {
            println!("\n[{}/{}] Processing wallet: {}...", idx + 1, addresses.len(), address);
            let wallet_dir = solutions_dir.join(address);
            fs::create_dir_all(&wallet_dir)?;
            let wallet_offset = solver_params.suffix_offset.wrapping_add((idx as u128).wrapping_mul(1_000_000));
            let solve_state = solve_with_rom(&challenge, &rom, &solver_params, wallet_offset, address)?;
            for outcome in &solve_state.outcomes {
                let saved_to = save_solution(
                    &challenge_path,
                    &challenge,
                    outcome,
                    &solver_params,
                    solve_state.next_suffix,
                    &wallet_dir,
                    address,
                )?;
                println!("  Solution stored at {}", saved_to.display());
            }
            if let Some(last) = solve_state.outcomes.last() {
                let wallet_hashes = last.hashes;
                let wallet_secs = last.elapsed.as_secs_f64().max(1e-9);
                let wallet_hs = (wallet_hashes as f64) / wallet_secs;
                batch_total_hashes = batch_total_hashes.saturating_add(wallet_hashes);
                println!(
                    "  Wallet summary — total hashes: {}, elapsed: {:.2}s, avg: {:.0} H/s",
                    wallet_hashes,
                    wallet_secs,
                    wallet_hs
                );
            }
        }
    } else {
        // Run multiple wallets concurrently by splitting threads among workers
        let total_threads = solver_params.threads.max(1);
        let workers = wallet_concurrency.min(addresses.len());
        let base_threads = (total_threads / workers).max(1);
        let remainder = total_threads % workers;
        println!(
            "Running {} wallet(s) concurrently: {} threads total → {} per wallet{}",
            workers,
            total_threads,
            base_threads,
            if remainder>0 { " (some +1)" } else { "" }
        );

        use std::sync::mpsc::channel;
        #[derive(Clone)]
        struct Job { idx: usize, address: String }

        let (job_tx, job_rx) = channel::<Job>();
        for (i, addr) in addresses.iter().enumerate() {
            job_tx.send(Job { idx: i, address: addr.clone() }).unwrap();
        }
        drop(job_tx);
        let rx = Arc::new(Mutex::new(job_rx));

        // Stats channel to aggregate wallet hashes
        let (stat_tx, stat_rx) = channel::<u128>();

        let mut handles = Vec::with_capacity(workers);
        for wid in 0..workers {
            let rx = Arc::clone(&rx);
            let rom = Arc::clone(&rom);
            let challenge = challenge.clone();
            let challenge_path = challenge_path.clone();
            let solutions_dir = solutions_dir.clone();
            let mut sp = solver_params.clone();
            sp.threads = base_threads + if wid < remainder { 1 } else { 0 };
            let stat_tx = stat_tx.clone();
            let handle = thread::spawn(move || {
                while let Ok(job) = rx.lock().unwrap().recv() {
                    println!("\n[{}/{}] Processing wallet: {}... (worker {}, {} threads)", job.idx + 1, total_wallets, job.address, wid, sp.threads);
                    let wallet_dir = solutions_dir.join(&job.address);
                    let _ = fs::create_dir_all(&wallet_dir);
                    let wallet_offset = sp.suffix_offset.wrapping_add((job.idx as u128).wrapping_mul(1_000_000));
                    match solve_with_rom(&challenge, &rom, &sp, wallet_offset, &job.address) {
                        Ok(state) => {
                            for outcome in &state.outcomes {
                                if let Ok(saved_to) = save_solution(
                                    &challenge_path,
                                    &challenge,
                                    outcome,
                                    &sp,
                                    state.next_suffix,
                                    &wallet_dir,
                                    &job.address,
                                ) {
                                    println!("  Solution stored at {}", saved_to.display());
                                }
                            }
                            if let Some(last) = state.outcomes.last() {
                                let wallet_hashes = last.hashes;
                                let wallet_secs = last.elapsed.as_secs_f64().max(1e-9);
                                let wallet_hs = (wallet_hashes as f64) / wallet_secs;
                                println!(
                                    "  Wallet summary — total hashes: {}, elapsed: {:.2}s, avg: {:.0} H/s",
                                    wallet_hashes,
                                    wallet_secs,
                                    wallet_hs
                                );
                                let _ = stat_tx.send(wallet_hashes);
                            } else {
                                let _ = stat_tx.send(0);
                            }
                        }
                        Err(e) => {
                            eprintln!("  Wallet {} failed: {}", job.address, e);
                            let _ = stat_tx.send(0);
                        }
                    }
                }
            });
            handles.push(handle);
        }
        drop(stat_tx);
        // Collect stats
        for _ in 0..addresses.len() {
            if let Ok(h) = stat_rx.recv() {
                batch_total_hashes = batch_total_hashes.saturating_add(h);
            }
        }
        for h in handles { let _ = h.join(); }
    }

    println!("\nCompleted batch processing for {} wallet(s)", addresses.len());
    let batch_secs = batch_start.elapsed().as_secs_f64().max(1e-9);
    let batch_hs = (batch_total_hashes as f64) / batch_secs;
    println!(
        "Batch performance — total hashes: {}, elapsed: {:.2}s, avg: {:.0} H/s",
        batch_total_hashes,
        batch_secs,
        batch_hs
    );
    Ok(())
}

fn load_challenge(path: &Path) -> Result<Challenge, Box<dyn std::error::Error>> {
    let data = fs::read_to_string(path)?;
    let challenge: Challenge = serde_json::from_str(&data)?;
    Ok(challenge)
}

fn build_rom(
    challenge: &Challenge,
    params: &SolverParameters,
) -> Result<Arc<Rom>, Box<dyn std::error::Error>> {
    let rom_key = challenge.rom_key_hex.as_bytes();
    let _difficulty = challenge.difficulty_target()?;

    println!(
        "Building ROM (size: {} bytes, pre-size: {} bytes, mixing: {})",
        params.rom_size, params.pre_size, params.mixing_numbers
    );

    let rom = Rom::new(
        rom_key,
        RomGenerationType::TwoStep {
            pre_size: params.pre_size,
            mixing_numbers: params.mixing_numbers,
        },
        params.rom_size,
    );
    println!("ROM ready — digest: {:02X?}", rom.digest_bytes());

    Ok(Arc::new(rom))
}

fn solve_with_rom(
    challenge: &Challenge,
    rom: &Arc<Rom>,
    params: &SolverParameters,
    start_suffix: u128,
    address: &str,
) -> Result<SolveState, Box<dyn std::error::Error>> {
    let difficulty = challenge.difficulty_target()?;
    let nonce_prefix = challenge.nonce_prefix_u128()?;

    let mut rom_digest = [0u8; 64];
    rom_digest.copy_from_slice(rom.digest_bytes());

    let prefix = nonce_prefix << 64;
    let search_start = Instant::now();
    let started_at = SystemTime::now();
    let desired = params.solutions_per_batch.max(1);

    let stop_flag = Arc::new(AtomicBool::new(false));
    let total_hashes = Arc::new(AtomicU64::new(0));
    let solutions_found = Arc::new(AtomicUsize::new(0));
    let job_cursor = Arc::new(AtomicU64::new(0));
    let (result_tx, result_rx) = mpsc::channel::<FoundSolution>();

    let process_stride = params.suffix_stride.max(1);
    let batch_size = params.batch_size.max(1) as u64;
    let flush_interval = params.flush_interval.max(batch_size);
    let loops = params.nb_loops;
    let instrs = params.nb_instrs;

    let mut workers = Vec::with_capacity(params.threads);

    // Build the constant (per-thread) suffix for the preimage once, as bytes.
    // Layout: 16 ASCII hex chars for nonce_low64 + suffix_bytes
    let preimage_suffix = format!(
        "{}{}{}{}{}",
        address,
        challenge.challenge_id,
        challenge.difficulty,
        challenge.rom_key_hex,
        challenge.latest_submission
    ) + &challenge.nonce_prefix;
    let preimage_suffix_bytes = preimage_suffix.into_bytes();

    for _ in 0..params.threads {
        let rom = Arc::clone(rom);
        let result_tx = result_tx.clone();
        let stop_flag = Arc::clone(&stop_flag);
        let total_hashes = Arc::clone(&total_hashes);
        let solutions_found = Arc::clone(&solutions_found);
        let job_cursor = Arc::clone(&job_cursor);
        let worker_prefix = prefix;
        let worker_difficulty = difficulty;
        let process_stride = process_stride;
        let local_batch = batch_size as usize;
        let local_flush = flush_interval;
        let desired = desired;
        let start_time = search_start;
        // Clone bytes for this worker and pre-allocate the full preimage buffer once.
        let worker_suffix = preimage_suffix_bytes.clone();
        let total_len = 16 + worker_suffix.len();
        let mut preimage_buf = vec![0u8; total_len];
        preimage_buf[16..].copy_from_slice(&worker_suffix);

        workers.push(thread::spawn(move || {
            let mut local_hashes: u64 = 0;

            loop {
                if stop_flag.load(Ordering::Acquire) {
                    break;
                }

                let start_index = job_cursor.fetch_add(local_batch as u64, Ordering::Relaxed);
                for offset in 0..local_batch {
                    if stop_flag.load(Ordering::Acquire) {
                        break;
                    }

                    let idx = start_index + offset as u64;
                    let suffix =
                        start_suffix.wrapping_add(process_stride.wrapping_mul(idx as u128));
                    let nonce_value = worker_prefix | suffix;
                    let low64 = (nonce_value & u128::from(u64::MAX)) as u64;
                    // Write 16 ASCII hex chars of low64 into the first 16 bytes
                    write_hex16_be(low64, &mut preimage_buf[..16]);
                    let digest = hash(&preimage_buf, &rom, loops, instrs);
                    local_hashes = local_hashes.wrapping_add(1);

                    if meets_target(&digest, worker_difficulty) {
                        let total_after =
                            total_hashes.fetch_add(local_hashes, Ordering::Relaxed) + local_hashes;
                        local_hashes = 0;
                        let count_before = solutions_found.fetch_add(1, Ordering::AcqRel);
                        let _ = result_tx.send(FoundSolution {
                            nonce: nonce_value,
                            digest,
                            elapsed: start_time.elapsed(),
                            total_hashes: total_after as u128,
                        });
                        if count_before + 1 >= desired {
                            stop_flag.store(true, Ordering::Release);
                        }
                    }

                    if local_hashes >= local_flush {
                        total_hashes.fetch_add(local_hashes, Ordering::Relaxed);
                        local_hashes = 0;
                    }
                }
            }

            if local_hashes > 0 {
                total_hashes.fetch_add(local_hashes, Ordering::Relaxed);
            }
        }));
    }

    drop(result_tx);

    let mut collected = Vec::with_capacity(desired);
    while collected.len() < desired {
        match result_rx.recv() {
            Ok(solution) => collected.push(solution),
            Err(_) => break,
        }
    }

    stop_flag.store(true, Ordering::Release);

    for worker in workers {
        let _ = worker.join();
    }

    let total_hashes_final = total_hashes.load(Ordering::Relaxed) as u128;
    let next_index = job_cursor.load(Ordering::Relaxed);
    let next_suffix = start_suffix.wrapping_add(process_stride.wrapping_mul(next_index as u128));

    if collected.is_empty() {
        return Err(format!(
            "No solutions found after {} hashes",
            total_hashes_final
        ).into());
    }

    let mut collected = collected;
    collected.sort_by(|a, b| a.elapsed.cmp(&b.elapsed));

    let mut outcomes = Vec::with_capacity(collected.len());
    for (idx, found) in collected.into_iter().enumerate() {
        let finished_at = started_at + found.elapsed;

        outcomes.push(SolveOutcome {
            nonce: found.nonce,
            digest: found.digest,
            hashes: found.total_hashes,
            elapsed: found.elapsed,
            rom_digest,
            started_at,
            finished_at,
            batch_index: idx,
        });
    }

    Ok(SolveState {
        outcomes,
        next_suffix,
    })
}

fn save_solution(
    challenge_path: &Path,
    challenge: &Challenge,
    outcome: &SolveOutcome,
    params: &SolverParameters,
    next_suffix: u128,
    wallet_dir: &Path,
    address: &str,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    // Prefer unique, descriptive filename to avoid collisions across challenges and runs:
    // solution_DD-CC_NONCEHEX.json where DD = day (2 digits), CC = challenge_number (2 digits)
    let day = challenge.day as u64;
    let dd = format!("{:02}", day);
    let cc = format!("{:02}", challenge.challenge_number);
    let nonce_hex = format!("{:016x}", (outcome.nonce & u128::from(u64::MAX)) as u64);

    // Primary candidate
    let mut file_path = wallet_dir.join(format!("solution_{}-{}_{}.json", dd, cc, nonce_hex));

    // Fallback: if file exists (rare), append a numeric suffix
    if file_path.exists() {
        let mut counter = 2usize;
        loop {
            let candidate = wallet_dir.join(format!(
                "solution_{}-{}_{}_{}.json",
                dd, cc, nonce_hex, counter
            ));
            if !candidate.exists() {
                file_path = candidate;
                break;
            }
            counter += 1;
            if counter > 1000 {
                // As an ultimate fallback, revert to sequential naming
                let existing_files = fs::read_dir(wallet_dir)
                    .ok()
                    .map(|entries| {
                        entries
                            .filter_map(|e| e.ok())
                            .filter(|e| e.file_name().to_string_lossy().starts_with("solution_"))
                            .count()
                    })
                    .unwrap_or(0);
                file_path = wallet_dir.join(format!("solution_{}.json", existing_files + 1));
                break;
            }
        }
    }

    let salt_preimage = format!(
        "{:016x}{}{}{}{}{}",
        (outcome.nonce & u128::from(u64::MAX)) as u64,
        address,
        challenge.challenge_id,
        challenge.difficulty,
        challenge.rom_key_hex,
        challenge.latest_submission
    ) + &challenge.nonce_prefix;

    #[derive(Serialize)]
    struct SolutionRecord {
        challenge_number: u64,
        challenge_file: String,
        challenge: Challenge,
        solution_index: usize,
        difficulty_hex: String,
        rom_digest_hex: String,
        solver: SolverParameters,
        started_at_ms: u128,
        finished_at_ms: u128,
        elapsed_seconds: f64,
        total_hashes: String,
        hash_rate_hs: f64,
        nonce_hex: String,
        nonce_decimal: String,
        digest_hex: String,
        salt: String,
        next_suffix_hex: String,
        next_suffix_decimal: String,
        batch_index: usize,
    }

    let record = SolutionRecord {
        challenge_number: challenge.challenge_number,
        challenge_file: challenge_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| challenge_path.display().to_string()),
        challenge: challenge.clone(),
        solution_index: 1,
        difficulty_hex: challenge.difficulty.clone(),
        rom_digest_hex: hex::encode(outcome.rom_digest),
        solver: params.clone(),
        started_at_ms: unix_ms(outcome.started_at),
        finished_at_ms: unix_ms(outcome.finished_at),
        elapsed_seconds: outcome.elapsed.as_secs_f64(),
        total_hashes: outcome.hashes.to_string(),
        hash_rate_hs: outcome.hashes as f64 / outcome.elapsed.as_secs_f64().max(1e-9),
        nonce_hex: format!("{:016x}", (outcome.nonce & u128::from(u64::MAX)) as u64),
        nonce_decimal: outcome.nonce.to_string(),
        digest_hex: hex::encode(outcome.digest),
        salt: salt_preimage,
        next_suffix_hex: format!("{:032x}", next_suffix),
        next_suffix_decimal: next_suffix.to_string(),
        batch_index: outcome.batch_index,
    };

    let json = serde_json::to_string_pretty(&record)?;
    fs::write(&file_path, format!("{json}\n"))?;

    Ok(file_path)
}

fn env_usize(var: &str, default: usize) -> usize {
    env::var(var)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn env_u32(var: &str, default: u32) -> u32 {
    env::var(var)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn env_u64(var: &str, default: u64) -> u64 {
    env::var(var)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn env_u128(var: &str, default: u128) -> u128 {
    env::var(var)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn parse_difficulty(input: &str) -> Result<u32, ParseIntError> {
    u32::from_str_radix(input.trim_start_matches("0x"), 16)
}

/// AshMaize difficulty is a bitmask on the left-most 4 bytes (big-endian) of the hash.
///
/// A candidate share is valid only if every 0-bit in `mask` is also 0 in the hash prefix.
/// This differs from a numeric threshold compare; high-order ones do not loosen the target —
/// only explicit zero bits increase difficulty. Formally, the share is valid iff
/// `(head & !mask) == 0`.
fn meets_target(digest: &[u8; 64], mask: u32) -> bool {
    let head = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    (head & !mask) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest_from_head(head: u32) -> [u8; 64] {
        let mut digest = [0u8; 64];
        digest[..4].copy_from_slice(&head.to_be_bytes());
        digest
    }

    #[test]
    fn meets_target_accepts_when_required_bits_are_zero() {
        let mask = 0xFFFF_FFFE;
        let digest = digest_from_head(0x1234_5670);
        assert!(meets_target(&digest, mask));
    }

    #[test]
    fn meets_target_rejects_when_required_zero_bit_is_set() {
        let mask = 0xFFFF_FFFE;
        let digest = digest_from_head(0x1234_5671);
        assert!(!meets_target(&digest, mask));
    }

    #[test]
    fn meets_target_rejects_numeric_false_positive() {
        let mask = 0x0000_777F;
        let digest = digest_from_head(0x0000_0800);
        assert!(!meets_target(&digest, mask));
    }

    #[test]
    fn masks_with_same_zero_bits_share_difficulty_level() {
        let mask_a = 0x0000_777F;
        let mask_b = 0x0000_1FFF;

        assert_ne!(mask_a, mask_b);
        assert_eq!((!mask_a).count_ones(), (!mask_b).count_ones());

        let digest = digest_from_head(mask_a & mask_b);
        assert!(meets_target(&digest, mask_a));
        assert!(meets_target(&digest, mask_b));
    }
}

fn unix_ms(ts: SystemTime) -> u128 {
    ts.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[inline(always)]
fn write_hex16_be(value: u64, out: &mut [u8]) {
    // Writes 16 lowercase hex chars (big-endian hex representation of value) into out[0..16]
    debug_assert!(out.len() >= 16);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    // Process each nibble from most-significant to least-significant
    for i in 0..16 {
        let shift = (15 - i) * 4;
        let nib = ((value >> shift) & 0xF) as usize;
        out[i] = HEX[nib];
    }
}
