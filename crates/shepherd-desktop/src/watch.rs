//! Instant refresh: watches the files the panels read (agents, bus, runs, tasks) and tells the webview
//! when one changes, so the panels stop depending on a timer. Reads still come straight from those
//! files; writes still go through the server, which stays their only writer.

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

/// A burst of writes (a registry save, a status file, a bus line) is reported once.
const QUIET: Duration = Duration::from_millis(120);

pub struct StateWatcher {
    watcher: RecommendedWatcher,
    watched: HashSet<PathBuf>,
}

impl StateWatcher {
    pub fn start(on_change: impl Fn() + Send + 'static) -> notify::Result<Self> {
        let (tx, rx) = mpsc::channel::<()>();
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            if event.is_ok_and(|e| !matches!(e.kind, EventKind::Access(_))) {
                let _ = tx.send(());
            }
        })?;
        std::thread::spawn(move || {
            while rx.recv().is_ok() {
                while rx.recv_timeout(QUIET).is_ok() {} // let the burst finish
                on_change();
            }
        });
        Ok(Self {
            watcher,
            watched: HashSet::new(),
        })
    }

    /// Starts watching `dir` (once). Returns whether it was added; a missing directory is skipped.
    pub fn watch(&mut self, dir: &Path, recursive: bool) -> notify::Result<bool> {
        if !dir.is_dir() || self.watched.contains(dir) {
            return Ok(false);
        }
        let mode = if recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        self.watcher.watch(dir, mode)?;
        self.watched.insert(dir.to_path_buf());
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn a_burst_of_writes_is_reported_once_and_quickly() {
        let dir = std::env::temp_dir().join(format!("shepherd-watch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        let mut watcher = StateWatcher::start(move || {
            seen.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        assert!(watcher.watch(&dir, false).unwrap());
        assert!(!watcher.watch(&dir, false).unwrap(), "watched once");
        assert!(
            !watcher.watch(&dir.join("missing"), true).unwrap(),
            "a missing folder is skipped"
        );

        for i in 0..5 {
            std::fs::write(dir.join("agents.json"), format!("{{\"n\":{i}}}")).unwrap();
        }
        let start = std::time::Instant::now();
        while count.load(Ordering::SeqCst) == 0 && start.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "reported within a second"
        );
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(
            count.load(Ordering::SeqCst),
            1,
            "five writes, one notification"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
