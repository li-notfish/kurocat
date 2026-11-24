//! Lightweight diagnostics for input latency and stutter problems.
//!
//! KuroCat used to write no log at all, so a lag report coming from another
//! machine could not be analysed. This module keeps a handful of counters and
//! appends a compact summary line every couple of seconds to
//! `<config dir>/diagnostics.log`.
//!
//! Nothing that reaches the log contains key codes, typed text or window
//! titles - only counters, rates and the names of the connected devices.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The log is rotated once it grows past this size.
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

/// How often a summary line is written.
const SUMMARY_INTERVAL: Duration = Duration::from_secs(2);

/// Whether the log is written at all.
static ENABLED: AtomicBool = AtomicBool::new(true);

/// Raw HID reports the tablet thread has seen.
pub static PEN_REPORTS: AtomicU64 = AtomicU64::new(0);
/// Pen samples forwarded to the frontend.
pub static PEN_EMITS: AtomicU64 = AtomicU64::new(0);
/// Pen samples replaced by a newer one before they could be emitted.
pub static PEN_COALESCED: AtomicU64 = AtomicU64::new(0);
/// Pen samples dropped because the nib did not move far enough.
pub static PEN_UNCHANGED: AtomicU64 = AtomicU64::new(0);
/// Pen samples dropped because the previous one was still too recent.
pub static PEN_RATE_LIMITED: AtomicU64 = AtomicU64::new(0);
/// Nib transitions.
pub static PEN_TIP_DOWN: AtomicU64 = AtomicU64::new(0);
pub static PEN_TIP_UP: AtomicU64 = AtomicU64::new(0);
/// Raw pointer packets that a tablet sent in pointer mode.
pub static PEN_POINTER_PACKETS: AtomicU64 = AtomicU64::new(0);
/// Pen samples that were rebuilt from a pointer mode tablet.
pub static PEN_POINTER_EMITS: AtomicU64 = AtomicU64::new(0);
/// Pointer samples dropped because the pointer did not move.
pub static PEN_POINTER_UNCHANGED: AtomicU64 = AtomicU64::new(0);
/// Pointer samples dropped because the previous one was still too recent.
pub static PEN_POINTER_RATE_LIMITED: AtomicU64 = AtomicU64::new(0);
/// Mouse moves seen by the low level hook.
pub static MOUSE_MOVES_SEEN: AtomicU64 = AtomicU64::new(0);
/// Mouse moves forwarded to the frontend.
pub static MOUSE_MOVES_FORWARDED: AtomicU64 = AtomicU64::new(0);
/// Mouse moves dropped because the nib was on the surface.
pub static MOUSE_MOVES_SUPPRESSED: AtomicU64 = AtomicU64::new(0);
/// Key events forwarded to the frontend.
pub static KEY_EVENTS: AtomicU64 = AtomicU64::new(0);
/// How often the global hooks were installed or removed.
pub static HOOK_PAUSE_CHANGES: AtomicU64 = AtomicU64::new(0);
/// Every `kuro-input` event that was sent to the frontend.
pub static IPC_EMITS: AtomicU64 = AtomicU64::new(0);
/// Frames per second the frontend measured during the last window.
pub static RENDER_FPS_MILLI: AtomicU64 = AtomicU64::new(0);
/// Frames that exceeded the frame budget during the last window.
pub static RENDER_LONG_FRAMES: AtomicU64 = AtomicU64::new(0);
/// Slowest frame of the last window.
pub static RENDER_MAX_WORK_MS_MILLI: AtomicU64 = AtomicU64::new(0);
/// Largest gap between two frames of the last window.
pub static RENDER_MAX_GAP_MS_MILLI: AtomicU64 = AtomicU64::new(0);
/// Pen events the frontend received during the last window.
pub static FRONTEND_PEN_EVENTS: AtomicU64 = AtomicU64::new(0);
/// Largest gap between two pen events the frontend received.
pub static FRONTEND_PEN_GAP_MAX_MS_MILLI: AtomicU64 = AtomicU64::new(0);
/// Largest end to end latency of a pen sample, from the moment the backend
/// sent it to the moment the frontend handled it.
pub static FRONTEND_PEN_LAT_MAX_MS_MILLI: AtomicU64 = AtomicU64::new(0);

static WRITER: OnceLock<Sender<String>> = OnceLock::new();
static STARTED: OnceLock<()> = OnceLock::new();

/// Process relative millisecond clock. Every thread shares it so a deadline
/// written on one thread can be compared on another.
pub fn now_millis() -> u64 {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    EPOCH.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Wall clock in milliseconds since the epoch. The frontend compares this
/// against `Date.now()`, so a pen sample can carry the moment it was sent
/// and the browser can report the real delivery latency.
pub fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Identifies the exact build a log came from. A log from another machine is
/// useless when it is not known which code produced it.
pub fn build_id() -> String {
    format!("{}+{}", env!("CARGO_PKG_VERSION"), env!("KUROCAT_BUILD_ID"))
}

/// Absolute path of the diagnostics log. `KUROCAT_DIAGNOSTICS_LOG` overrides
/// the default location, which makes it easy to collect the log somewhere
/// else while reproducing a problem.
pub fn log_path() -> PathBuf {
    if let Ok(custom) = std::env::var("KUROCAT_DIAGNOSTICS_LOG") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    crate::config::app_data_dir().join("diagnostics.log")
}

/// Whether the log is currently written.
pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Switch the log on or off.
pub fn set_enabled(enabled: bool) {
    let was = ENABLED.swap(enabled, Ordering::SeqCst);
    if was == enabled {
        return;
    }
    if enabled {
        push_line(&format!(
            "{} | event diagnostics enabled build={} log={}",
            timestamp(),
            build_id(),
            log_path().display()
        ));
    } else {
        // This one has to bypass the switch that was just flipped.
        push_line(&format!("{} | event diagnostics disabled", timestamp()));
    }
}

/// Starts the writer thread and the periodic summary.
pub fn start() {
    STARTED.get_or_init(|| {
        if is_enabled() {
            push_line(&format!(
                "{} | event session start build={} log={}",
                timestamp(),
                build_id(),
                log_path().display()
            ));
        }
        let _ = std::thread::Builder::new()
            .name("kurocat-diagnostics".to_string())
            .spawn(summary_loop);
    });
}

/// Appends a one-off event line. Events are rare, so they can afford a
/// string allocation.
pub fn event(message: &str) {
    write_line(&format!("{} | event {}", timestamp(), message));
}

/// Stores the render health the frontend measured during the last window.
pub fn set_render_stats(
    fps: f64,
    long_frames: u64,
    max_work_ms: f64,
    max_gap_ms: f64,
    pen_events: u64,
    max_pen_gap_ms: f64,
    max_pen_lat_ms: f64,
) {
    RENDER_FPS_MILLI.store(to_milli(fps), Ordering::Relaxed);
    RENDER_LONG_FRAMES.store(long_frames, Ordering::Relaxed);
    RENDER_MAX_WORK_MS_MILLI.store(to_milli(max_work_ms), Ordering::Relaxed);
    RENDER_MAX_GAP_MS_MILLI.store(to_milli(max_gap_ms), Ordering::Relaxed);
    FRONTEND_PEN_EVENTS.store(pen_events, Ordering::Relaxed);
    FRONTEND_PEN_GAP_MAX_MS_MILLI.store(to_milli(max_pen_gap_ms), Ordering::Relaxed);
    FRONTEND_PEN_LAT_MAX_MS_MILLI.store(to_milli(max_pen_lat_ms), Ordering::Relaxed);
}

fn to_milli(value: f64) -> u64 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    (value * 1000.0).round() as u64
}

fn write_line(line: &str) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    push_line(line);
}

fn push_line(line: &str) {
    let _ = writer().send(line.to_string());
}

fn writer() -> &'static Sender<String> {
    WRITER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<String>();
        let _ = std::thread::Builder::new()
            .name("kurocat-diagnostics-writer".to_string())
            .spawn(move || write_loop(rx));
        tx
    })
}

fn write_loop(rx: mpsc::Receiver<String>) {
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    let mut file: Option<File> = OpenOptions::new().create(true).append(true).open(&path).ok();
    while let Ok(line) = rx.recv() {
        if file.is_none() {
            file = OpenOptions::new().create(true).append(true).open(&path).ok();
            size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        }
        let needs_rotation = match file.as_mut() {
            Some(_) => size + line.len() as u64 + 1 > MAX_LOG_BYTES,
            None => false,
        };
        if needs_rotation {
            if let Some(handle) = file.as_mut() {
                let _ = handle.flush();
            }
            let backup = path.with_file_name("diagnostics.log.1");
            let _ = fs::remove_file(&backup);
            let _ = fs::rename(&path, &backup);
            file = OpenOptions::new().create(true).append(true).open(&path).ok();
            size = 0;
        }
        let Some(handle) = file.as_mut() else {
            continue;
        };
        if handle.write_all(line.as_bytes()).is_ok() && handle.write_all(b"\n").is_ok() {
            size += line.len() as u64 + 1;
            let _ = handle.flush();
        }
    }
}

fn summary_loop() {
    let mut previous = snapshot();
    let mut last = now_millis();
    loop {
        std::thread::sleep(SUMMARY_INTERVAL);
        let now = now_millis();
        let elapsed = now.saturating_sub(last).max(1);
        last = now;
        let current = snapshot();
        let delta = current.delta(previous);
        previous = current;
        write_line(&summary_line(elapsed, delta));
    }
}

#[derive(Clone, Copy)]
struct Snapshot {
    pen_reports: u64,
    pen_emits: u64,
    pen_coalesced: u64,
    pen_unchanged: u64,
    pen_rate_limited: u64,
    pen_tip_down: u64,
    pen_tip_up: u64,
    pen_pointer_packets: u64,
    pen_pointer_emits: u64,
    pen_pointer_unchanged: u64,
    pen_pointer_rate_limited: u64,
    mouse_seen: u64,
    mouse_forwarded: u64,
    mouse_suppressed: u64,
    key_events: u64,
    hook_pause_changes: u64,
    ipc_emits: u64,
}

fn snapshot() -> Snapshot {
    Snapshot {
        pen_reports: PEN_REPORTS.load(Ordering::Relaxed),
        pen_emits: PEN_EMITS.load(Ordering::Relaxed),
        pen_coalesced: PEN_COALESCED.load(Ordering::Relaxed),
        pen_unchanged: PEN_UNCHANGED.load(Ordering::Relaxed),
        pen_rate_limited: PEN_RATE_LIMITED.load(Ordering::Relaxed),
        pen_tip_down: PEN_TIP_DOWN.load(Ordering::Relaxed),
        pen_tip_up: PEN_TIP_UP.load(Ordering::Relaxed),
        pen_pointer_packets: PEN_POINTER_PACKETS.load(Ordering::Relaxed),
        pen_pointer_emits: PEN_POINTER_EMITS.load(Ordering::Relaxed),
        pen_pointer_unchanged: PEN_POINTER_UNCHANGED.load(Ordering::Relaxed),
        pen_pointer_rate_limited: PEN_POINTER_RATE_LIMITED.load(Ordering::Relaxed),
        mouse_seen: MOUSE_MOVES_SEEN.load(Ordering::Relaxed),
        mouse_forwarded: MOUSE_MOVES_FORWARDED.load(Ordering::Relaxed),
        mouse_suppressed: MOUSE_MOVES_SUPPRESSED.load(Ordering::Relaxed),
        key_events: KEY_EVENTS.load(Ordering::Relaxed),
        hook_pause_changes: HOOK_PAUSE_CHANGES.load(Ordering::Relaxed),
        ipc_emits: IPC_EMITS.load(Ordering::Relaxed),
    }
}

impl Snapshot {
    fn delta(self, previous: Snapshot) -> Snapshot {
        Snapshot {
            pen_reports: self.pen_reports.saturating_sub(previous.pen_reports),
            pen_emits: self.pen_emits.saturating_sub(previous.pen_emits),
            pen_coalesced: self.pen_coalesced.saturating_sub(previous.pen_coalesced),
            pen_unchanged: self.pen_unchanged.saturating_sub(previous.pen_unchanged),
            pen_rate_limited: self
                .pen_rate_limited
                .saturating_sub(previous.pen_rate_limited),
            pen_tip_down: self.pen_tip_down.saturating_sub(previous.pen_tip_down),
            pen_tip_up: self.pen_tip_up.saturating_sub(previous.pen_tip_up),
            pen_pointer_packets: self
                .pen_pointer_packets
                .saturating_sub(previous.pen_pointer_packets),
            pen_pointer_emits: self.pen_pointer_emits.saturating_sub(previous.pen_pointer_emits),
            pen_pointer_unchanged: self
                .pen_pointer_unchanged
                .saturating_sub(previous.pen_pointer_unchanged),
            pen_pointer_rate_limited: self
                .pen_pointer_rate_limited
                .saturating_sub(previous.pen_pointer_rate_limited),
            mouse_seen: self.mouse_seen.saturating_sub(previous.mouse_seen),
            mouse_forwarded: self.mouse_forwarded.saturating_sub(previous.mouse_forwarded),
            mouse_suppressed: self.mouse_suppressed.saturating_sub(previous.mouse_suppressed),
            key_events: self.key_events.saturating_sub(previous.key_events),
            hook_pause_changes: self
                .hook_pause_changes
                .saturating_sub(previous.hook_pause_changes),
            ipc_emits: self.ipc_emits.saturating_sub(previous.ipc_emits),
        }
    }
}

fn summary_line(elapsed_ms: u64, delta: Snapshot) -> String {
    let seconds = elapsed_ms as f64 / 1000.0;
    let rate = |value: u64| ((value as f64 / seconds).round() as u64).to_string();
    let fps = RENDER_FPS_MILLI.load(Ordering::Relaxed) as f64 / 1000.0;
    let work = RENDER_MAX_WORK_MS_MILLI.load(Ordering::Relaxed) as f64 / 1000.0;
    let gap = RENDER_MAX_GAP_MS_MILLI.load(Ordering::Relaxed) as f64 / 1000.0;
    let pen_gap = FRONTEND_PEN_GAP_MAX_MS_MILLI.load(Ordering::Relaxed) as f64 / 1000.0;
    let pen_lat = FRONTEND_PEN_LAT_MAX_MS_MILLI.load(Ordering::Relaxed) as f64 / 1000.0;
    format!(
        "{} | summary dt={}ms pen_report={}/s pen_emit={}/s pen_coal={} pen_unch={} pen_rlmt={} pen_tip={}/{} pen_ptr={}/s pen_ptr_emit={}/s pen_ptr_unch={} pen_ptr_rlmt={} mouse_seen={}/s mouse_fwd={}/s mouse_sup={}/s keys={}/s hook_pause={} ipc={}/s fe_pen={} fe_pen_gap_max={}ms fe_pen_lat_max={}ms fps={} long={} work_max={}ms gap_max={}ms",
        timestamp(),
        elapsed_ms,
        rate(delta.pen_reports),
        rate(delta.pen_emits),
        delta.pen_coalesced,
        delta.pen_unchanged,
        delta.pen_rate_limited,
        delta.pen_tip_down,
        delta.pen_tip_up,
        rate(delta.pen_pointer_packets),
        rate(delta.pen_pointer_emits),
        delta.pen_pointer_unchanged,
        delta.pen_pointer_rate_limited,
        rate(delta.mouse_seen),
        rate(delta.mouse_forwarded),
        rate(delta.mouse_suppressed),
        rate(delta.key_events),
        delta.hook_pause_changes,
        rate(delta.ipc_emits),
        FRONTEND_PEN_EVENTS.load(Ordering::Relaxed),
        pen_gap,
        pen_lat,
        fps,
        RENDER_LONG_FRAMES.load(Ordering::Relaxed),
        work,
        gap,
    )
}

/// Wall clock timestamp with millisecond resolution.
#[cfg(windows)]
fn timestamp() -> String {
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;

    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_millis())
        .unwrap_or(0);
    let mut local: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut local) };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        local.wYear,
        local.wMonth,
        local.wDay,
        local.wHour,
        local.wMinute,
        local.wSecond,
        millis
    )
}

#[cfg(not(windows))]
fn timestamp() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}", now.as_secs(), now.subsec_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot_with(pen_reports: u64, pen_emits: u64) -> Snapshot {
        Snapshot {
            pen_reports,
            pen_emits,
            pen_coalesced: 0,
            pen_unchanged: 0,
            pen_rate_limited: 0,
            pen_tip_down: 0,
            pen_tip_up: 0,
            pen_pointer_packets: 0,
            pen_pointer_emits: 0,
            pen_pointer_unchanged: 0,
            pen_pointer_rate_limited: 0,
            mouse_seen: 0,
            mouse_forwarded: 0,
            mouse_suppressed: 0,
            key_events: 0,
            hook_pause_changes: 0,
            ipc_emits: 0,
        }
    }

    #[test]
    fn delta_only_counts_what_happened_since_the_previous_snapshot() {
        let delta = snapshot_with(30, 12).delta(snapshot_with(10, 4));
        assert_eq!(delta.pen_reports, 20);
        assert_eq!(delta.pen_emits, 8);
    }

    #[test]
    fn delta_never_goes_backwards_when_a_counter_is_reset() {
        let delta = snapshot_with(5, 0).delta(snapshot_with(10, 0));
        assert_eq!(delta.pen_reports, 0);
    }

    #[test]
    fn summary_line_turns_counters_into_per_second_rates() {
        let delta = snapshot_with(60, 40).delta(snapshot_with(0, 0));
        let line = summary_line(2000, delta);
        assert!(line.contains("pen_report=30/s"), "{line}");
        assert!(line.contains("pen_emit=20/s"), "{line}");
    }

    #[test]
    fn delta_counts_the_pointer_mode_packets() {
        let mut current = snapshot_with(0, 0);
        current.pen_pointer_packets = 12;
        current.pen_pointer_emits = 7;
        let delta = current.delta(snapshot_with(0, 0));
        assert_eq!(delta.pen_pointer_packets, 12);
        assert_eq!(delta.pen_pointer_emits, 7);
    }

    #[test]
    fn summary_line_reports_the_pointer_mode_counters() {
        let delta = snapshot_with(0, 0).delta(snapshot_with(0, 0));
        let line = summary_line(2000, delta);
        assert!(line.contains("pen_ptr="), "{line}");
    }

    #[test]
    fn build_id_names_the_version_and_the_commit() {
        let id = build_id();
        assert!(
            id.starts_with(&format!("{}+", env!("CARGO_PKG_VERSION"))),
            "unexpected build id: {id}"
        );
        assert!(id.len() > env!("CARGO_PKG_VERSION").len() + 1, "{id}");
    }

    #[test]
    fn milli_conversion_rejects_nonsense_values() {
        assert_eq!(to_milli(f64::NAN), 0);
        assert_eq!(to_milli(-1.0), 0);
        assert_eq!(to_milli(12.5), 12_500);
    }
}
