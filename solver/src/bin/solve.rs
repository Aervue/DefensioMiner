use std::{
    collections::HashMap,
    env, fs, io,
    num::ParseIntError,
    path::{Path, PathBuf},
    process,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use ashmaize::{Rom, RomGenerationType, hash};
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

    fn log_interval(&self) -> Option<Duration> {
        if self.log_interval_ms == 0 {
            None
        } else {
            Some(Duration::from_millis(self.log_interval_ms))
        }
    }
}

struct ContinuousSettings {
    challenge_dir: PathBuf,
    solutions_dir: PathBuf,
    poll_interval: Duration,
}

#[derive(Debug, Clone)]
struct ChallengeFile {
    number: u64,
    path: PathBuf,
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

struct CachedChallenge {
    file: ChallengeFile,
    challenge: Challenge,
    rom: Arc<Rom>,
    next_suffix: u128,
}

// Global ROM cache keyed by challenge rom_key + solver params
type RomCacheKey = String;
static ROM_CACHE: OnceLock<Mutex<HashMap<RomCacheKey, Arc<Rom>>>> = OnceLock::new();

fn get_rom_cache() -> &'static Mutex<HashMap<RomCacheKey, Arc<Rom>>> {
    ROM_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
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
    
    // Try to get from cache
    {
        let cache_guard = cache.lock().unwrap();
        if let Some(cached_rom) = cache_guard.get(&cache_key) {
            println!("Using cached ROM for challenge {}", challenge.challenge_number);
            return Ok(Arc::clone(cached_rom));
        }
    }
    
    // Build new ROM
    println!("Building ROM for challenge {} (will be cached)", challenge.challenge_number);
    let rom_arc = build_rom(challenge, params)?;
    
    // Store in cache
    {
        let mut cache_guard = cache.lock().unwrap();
        cache_guard.insert(cache_key, Arc::clone(&rom_arc));
    }
    
    Ok(rom_arc)
}

#[derive(Serialize)]
struct SolutionRecord {
    challenge_number: u64,
    challenge_file: String,
    challenge: Challenge,
    solution_index: u64,
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

fn main() {
    if let Err(err) = run() {
        eprintln!("error: {err}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    let mut solver_params = SolverParameters::from_env();
    
    // Force single solution per run
    solver_params.solutions_per_batch = 1;

    // Parse address from args (--address single or env var, no --addresses support)
    let address = if let Some(idx) = args.iter().position(|a| a == "--address" || a == "-a") {
        if idx + 1 < args.len() {
            args[idx + 1].clone()
        } else {
            return Err("--address requires a value".into());
        }
    } else {
        // Fallback to env var
        env::var("WALLET_ADDRESS")
            .or_else(|_| env::var("ASHMAIZE_ADDRESS"))
            .map_err(|_| "WALLET_ADDRESS, ASHMAIZE_ADDRESS, or --address must be provided")?
    };

    // Filter out address-related args for path parsing
    let path_args: Vec<&String> = args.iter()
        .enumerate()
        .filter_map(|(i, arg)| {
            if arg == "--address" || arg == "-a" ||
               (i > 0 && (args[i-1] == "--address" || args[i-1] == "-a")) {
                None
            } else {
                Some(arg)
            }
        })
        .collect();
    
    if path_args.is_empty() {
        // No path provided, run in continuous mode
        run_continuous_default(solver_params, &address)?;
    } else {
        let path = PathBuf::from(path_args[0]);
        
        if path.is_dir() {
            let settings = build_continuous_settings(Some(path))?;
            run_continuous(settings, solver_params, &address)?;
        } else if path.is_file() {
            run_single(&path, &solver_params, &address)?;
        } else {
            return Err(format!(
                "path '{}' does not exist or is not accessible",
                path.display()
            )
            .into());
        }
    }

    Ok(())
}

fn run_continuous_default(params: SolverParameters, address: &str) -> Result<(), Box<dyn std::error::Error>> {
    let settings = build_continuous_settings(None)?;
    run_continuous(settings, params, address)
}

fn build_continuous_settings(
    override_dir: Option<PathBuf>,
) -> Result<ContinuousSettings, Box<dyn std::error::Error>> {
    let challenge_dir = override_dir.unwrap_or_else(|| {
        env::var("ASHMAIZE_CHALLENGES_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("challanges"))
    });

    fs::create_dir_all(&challenge_dir)?;

    let solutions_dir = env::var("ASHMAIZE_SOLUTIONS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("solutions"));
    fs::create_dir_all(&solutions_dir)?;

    let poll_ms = env_u64("ASHMAIZE_SOLVER_POLL_MS", 5_000);

    Ok(ContinuousSettings {
        challenge_dir,
        solutions_dir,
        poll_interval: Duration::from_millis(poll_ms),
    })
}

fn run_single(
    challenge_path: &Path,
    params: &SolverParameters,
    address: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let challenge = load_challenge(challenge_path)?;
    let rom = get_or_build_rom(&challenge, params)?;
    let solve_state = solve_with_rom(&challenge, &rom, params, params.suffix_offset, address)?;
    
    // Return immediately with first solution (should only be one)
    if let Some(outcome) = solve_state.outcomes.first() {
        let solutions_dir = env::var("ASHMAIZE_SOLUTIONS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("solutions"));
        fs::create_dir_all(&solutions_dir)?;
        let saved_to = save_solution(
            challenge_path,
            &challenge,
            outcome,
            params,
            solve_state.next_suffix,
            &solutions_dir,
            address,
        )?;
        println!("{}", saved_to.display());
    }
    Ok(())
}

fn run_continuous(
    settings: ContinuousSettings,
    params: SolverParameters,
    address: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    println!(
        "Continuous mode — watching '{}' (solutions in '{}'), poll every {:?}",
        settings.challenge_dir.display(),
        settings.solutions_dir.display(),
        settings.poll_interval
    );

    let mut cached: Option<CachedChallenge> = None;

    loop {
        match latest_challenge(&settings.challenge_dir)? {
            Some(latest) => {
                let mut rebuild = false;
                if let Some(current) = cached.as_ref() {
                    if current.file.number != latest.number || current.file.path != latest.path {
                        rebuild = true;
                    }
                } else {
                    rebuild = true;
                }

                if rebuild {
                    println!(
                        "Switching to challenge {} (file {})",
                        latest.number,
                        latest.path.display()
                    );
                    let challenge = load_challenge(&latest.path)?;
                    let rom = get_or_build_rom(&challenge, &params)?;
                    cached = Some(CachedChallenge {
                        file: latest.clone(),
                        challenge,
                        rom,
                        next_suffix: params.suffix_offset,
                    });
                }

                let cache = cached.as_mut().expect("cached challenge must exist");
                let solve_state =
                    solve_with_rom(&cache.challenge, &cache.rom, &params, cache.next_suffix, address)?;
                cache.next_suffix = solve_state.next_suffix;
                for outcome in &solve_state.outcomes {
                    let saved_to = save_solution(
                        &cache.file.path,
                        &cache.challenge,
                        outcome,
                        &params,
                        solve_state.next_suffix,
                        &settings.solutions_dir,
                        address,
                    )?;
                    println!(
                        "Challenge {} solved — stored result at {}",
                        cache.challenge.challenge_number,
                        saved_to.display()
                    );
                }
            }
            None => {
                println!(
                    "No challenges detected; sleeping for {:?}",
                    settings.poll_interval
                );
                cached = None;
                thread::sleep(settings.poll_interval);
            }
        }
    }
}

fn latest_challenge(challenge_dir: &Path) -> io::Result<Option<ChallengeFile>> {
    let mut candidates = Vec::new();

    for entry in fs::read_dir(challenge_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if let Some(number) = extract_number(&file_name) {
            candidates.push(ChallengeFile {
                number,
                path: entry.path(),
            });
        }
    }

    candidates.sort_by(|a, b| b.number.cmp(&a.number));

    Ok(candidates.into_iter().next())
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
    // Mirror node/web: use ASCII bytes of the no_pre_mine string as key
    let rom_key = challenge.rom_key_hex.as_bytes();
    let difficulty = challenge.difficulty_target()?;

    println!(
        "Challenge {} — difficulty 0x{difficulty:08X}, ROM key len {}",
        challenge.challenge_number,
        rom_key.len()
    );
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

    println!(
        "Starting search from suffix {} (loops: {}, instrs: {}, threads: {}, target batch: {}, prefix: 0x{:016X})",
        start_suffix, params.nb_loops, params.nb_instrs, params.threads, desired, nonce_prefix
    );

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

    // Build the static preimage suffix per node/web miner
    let preimage_suffix = format!(
        "{}{}{}{}{}",
        address,
        challenge.challenge_id,
        challenge.difficulty,
        challenge.rom_key_hex,
        challenge.latest_submission
    ) + &challenge.nonce_prefix; // no_pre_mine_hour

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
        let preimage_suffix = preimage_suffix.clone();

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
                    // Preimage = nonce_hex (16 lowercase) + address + challengeId + difficulty + no_pre_mine + latestSubmission + no_pre_mine_hour
                    let low64 = (nonce_value & u128::from(u64::MAX)) as u64;
                    let preimage = format!("{:016x}{}", low64, preimage_suffix);
                    let digest = hash(preimage.as_bytes(), &rom, loops, instrs);
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

    let logger = if let Some(interval) = params.log_interval() {
        let log_found = Arc::clone(&stop_flag);
        let log_hashes = Arc::clone(&total_hashes);
        let log_start = search_start;
        Some(thread::spawn(move || {
            while !log_found.load(Ordering::Acquire) {
                thread::sleep(interval);
                let hashes = log_hashes.load(Ordering::Relaxed) as u128;
                if hashes == 0 {
                    continue;
                }
                let elapsed = log_start.elapsed().as_secs_f64().max(1e-6);
                let rate = hashes as f64 / elapsed;
                println!("Checked {:>15} salts — {:>8.2} H/s", hashes, rate);
            }
        }))
    } else {
        None
    };

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
    if let Some(logger) = logger {
        let _ = logger.join();
    }

    let total_hashes_final = total_hashes.load(Ordering::Relaxed) as u128;
    let next_index = job_cursor.load(Ordering::Relaxed);
    let next_suffix = start_suffix.wrapping_add(process_stride.wrapping_mul(next_index as u128));

    if collected.is_empty() {
        println!(
            "No solutions found in batch after {} hashes; continuing...",
            total_hashes_final
        );
    }

    let mut collected = collected;
    collected.sort_by(|a, b| a.elapsed.cmp(&b.elapsed));

    let mut outcomes = Vec::with_capacity(collected.len());
    for (idx, found) in collected.into_iter().enumerate() {
        let finished_at = started_at + found.elapsed;
        println!(
            "Solution #{idx} found: nonce 0x{:032X}, hashes {}, elapsed {:.2?}",
            found.nonce, found.total_hashes, found.elapsed
        );

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
    solutions_dir: &Path,
    address: &str,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let challenge_dir = solutions_dir.join(challenge.challenge_number.to_string());
    fs::create_dir_all(&challenge_dir)?;
    let solution_index = next_solution_index(&challenge_dir)?;
    let file_path = challenge_dir.join(format!("{solution_index}.json"));

    // Build the exact preimage (salt) used during hashing for this outcome
    let salt_preimage = format!(
        "{:016x}{}{}{}{}{}",
        (outcome.nonce & u128::from(u64::MAX)) as u64,
        address,
        challenge.challenge_id,
        challenge.difficulty,
        challenge.rom_key_hex,
        challenge.latest_submission
    ) + &challenge.nonce_prefix; // no_pre_mine_hour

    let record = SolutionRecord {
        challenge_number: challenge.challenge_number,
        challenge_file: challenge_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| challenge_path.display().to_string()),
        challenge: challenge.clone(),
        solution_index,
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

fn next_solution_index(challenge_dir: &Path) -> io::Result<u64> {
    let mut max_index = 0u64;
    if challenge_dir.exists() {
        for entry in fs::read_dir(challenge_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name();
            if let Some(num) = extract_number(&name.to_string_lossy()) {
                max_index = max_index.max(num);
            }
        }
    }
    Ok(max_index + 1)
}

fn extract_number(name: &str) -> Option<u64> {
    let digits: String = name.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse().ok()
    }
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

fn meets_target(digest: &[u8; 64], target: u32) -> bool {
    let head = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    head <= target
}

fn unix_ms(ts: SystemTime) -> u128 {
    ts.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
