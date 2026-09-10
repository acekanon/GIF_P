//! Per-export, thread-local measurements and bounded immutable palette reuse.
//! No source paths or caption contents are included in the serialized report.
use serde::Serialize;
use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::OsString,
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

pub(crate) const PALETTE_CACHE_LIMIT_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy)]
pub(crate) enum Phase {
    Setup,
    Probe,
    DecodeTransform,
    FrameAnalysis,
    Palette,
    Encode,
    Validation,
    Publish,
}

const PHASE_NAMES: [&str; 8] = [
    "setup_and_routing",
    "source_probe",
    "decode_transform",
    "frame_analysis",
    "palette_generation",
    "mapping_and_encoding",
    "candidate_validation",
    "publish",
];

#[derive(Clone, Debug, Serialize)]
pub struct StageTiming {
    pub stage: &'static str,
    pub calls: u64,
    /// Exclusive elapsed wall time: child stages are not counted twice.
    pub elapsed_us: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct PaletteCacheReport {
    pub limit_bytes: usize,
    pub retained_bytes: usize,
    pub hits: u64,
    pub misses: u64,
    pub bypasses: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct PipelineProfile {
    pub schema_version: u16,
    pub scope: &'static str,
    pub elapsed_us: u64,
    pub stages: Vec<StageTiming>,
    pub palette_cache: PaletteCacheReport,
    pub source_probe_cache: PaletteCacheReport,
}

pub(crate) type PaletteKey = Vec<OsString>;

struct State {
    started: Instant,
    checkpoint: Instant,
    phase: Phase,
    durations: [Duration; 8],
    calls: [u64; 8],
    palettes: HashMap<PaletteKey, Arc<Vec<u8>>>,
    cache: PaletteCacheReport,
    source_probes: HashMap<PaletteKey, serde_json::Value>,
    probe_cache: PaletteCacheReport,
}

impl State {
    fn new(limit_bytes: usize) -> Self {
        let now = Instant::now();
        let mut calls = [0; 8];
        calls[Phase::Setup as usize] = 1;
        Self {
            started: now,
            checkpoint: now,
            phase: Phase::Setup,
            durations: [Duration::ZERO; 8],
            calls,
            palettes: HashMap::new(),
            cache: PaletteCacheReport {
                limit_bytes,
                ..Default::default()
            },
            source_probes: HashMap::new(),
            probe_cache: PaletteCacheReport {
                limit_bytes: 64 * 1024,
                ..Default::default()
            },
        }
    }

    fn switch(&mut self, next: Phase, now: Instant) -> Phase {
        self.durations[self.phase as usize] += now.saturating_duration_since(self.checkpoint);
        let previous = self.phase;
        self.phase = next;
        self.checkpoint = now;
        previous
    }

    fn get(&mut self, key: &PaletteKey) -> Option<Arc<Vec<u8>>> {
        if let Some(bytes) = self.palettes.get(key) {
            self.cache.hits += 1;
            return Some(Arc::clone(bytes));
        }
        self.cache.misses += 1;
        None
    }

    fn insert(&mut self, key: PaletteKey, bytes: Vec<u8>) {
        if self.palettes.contains_key(&key) {
            return;
        }
        if self.palettes.len() >= 32
            || bytes.is_empty()
            || bytes.len()
                > self
                    .cache
                    .limit_bytes
                    .saturating_sub(self.cache.retained_bytes)
        {
            self.cache.bypasses += 1;
            return;
        }
        self.cache.retained_bytes += bytes.len();
        self.palettes.insert(key, Arc::new(bytes));
    }
}

thread_local! {
    static CURRENT: RefCell<Option<Rc<RefCell<State>>>> = const { RefCell::new(None) };
}

pub(crate) struct PipelineScope {
    state: Rc<RefCell<State>>,
    previous: Option<Rc<RefCell<State>>>,
}

impl PipelineScope {
    pub(crate) fn disable_source_probe_cache(&self) {
        let mut state = self.state.borrow_mut();
        state.source_probes.clear();
        state.probe_cache = PaletteCacheReport::default();
    }
    pub(crate) fn start(cache_limit_bytes: usize) -> Self {
        let state = Rc::new(RefCell::new(State::new(cache_limit_bytes)));
        let previous = CURRENT.with(|slot| slot.replace(Some(Rc::clone(&state))));
        Self { state, previous }
    }

    pub(crate) fn report(&self) -> PipelineProfile {
        let mut state = self.state.borrow_mut();
        let now = Instant::now();
        let phase = state.phase;
        state.switch(phase, now);
        PipelineProfile {
            schema_version: 1,
            scope: "encode_only_exclusive_wall_time",
            elapsed_us: micros(now.saturating_duration_since(state.started)),
            stages: PHASE_NAMES
                .iter()
                .enumerate()
                .map(|(i, name)| StageTiming {
                    stage: name,
                    calls: state.calls[i],
                    elapsed_us: micros(state.durations[i]),
                })
                .collect(),
            palette_cache: state.cache.clone(),
            source_probe_cache: state.probe_cache.clone(),
        }
    }
}

impl Drop for PipelineScope {
    fn drop(&mut self) {
        CURRENT.with(|slot| {
            slot.replace(self.previous.take());
        });
    }
}

fn micros(duration: Duration) -> u64 {
    duration.as_micros().min(u128::from(u64::MAX)) as u64
}

pub(crate) struct StageGuard {
    state: Option<Rc<RefCell<State>>>,
    previous: Phase,
}

pub(crate) fn stage(phase: Phase) -> StageGuard {
    let state = CURRENT.with(|slot| slot.borrow().clone());
    let previous = state.as_ref().map_or(Phase::Setup, |state| {
        let mut state = state.borrow_mut();
        state.calls[phase as usize] += 1;
        state.switch(phase, Instant::now())
    });
    StageGuard { state, previous }
}

impl Drop for StageGuard {
    fn drop(&mut self) {
        if let Some(state) = self.state.as_ref() {
            state.borrow_mut().switch(self.previous, Instant::now());
        }
    }
}

pub(crate) fn cached_palette(key: &PaletteKey) -> Option<Arc<Vec<u8>>> {
    CURRENT.with(|slot| {
        slot.borrow()
            .as_ref()
            .and_then(|state| state.borrow_mut().get(key))
    })
}

pub(crate) fn retain_palette(key: PaletteKey, bytes: Vec<u8>) {
    CURRENT.with(|slot| {
        if let Some(state) = slot.borrow().as_ref() {
            state.borrow_mut().insert(key, bytes);
        }
    });
}

pub(crate) fn palette_cache_enabled() -> bool {
    CURRENT.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(|state| state.borrow().cache.limit_bytes > 0)
    })
}

pub(crate) fn source_probe_cache_enabled() -> bool {
    CURRENT.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(|state| state.borrow().probe_cache.limit_bytes > 0)
    })
}

pub(crate) fn cached_source_probe(key: &PaletteKey) -> Option<serde_json::Value> {
    CURRENT.with(|slot| {
        let current = slot.borrow();
        let mut state = current.as_ref()?.borrow_mut();
        if let Some(value) = state.source_probes.get(key).cloned() {
            state.probe_cache.hits += 1;
            Some(value)
        } else {
            state.probe_cache.misses += 1;
            None
        }
    })
}

pub(crate) fn retain_source_probe(key: PaletteKey, value: serde_json::Value) {
    CURRENT.with(|slot| {
        let current = slot.borrow();
        let Some(current) = current.as_ref() else {
            return;
        };
        let mut state = current.borrow_mut();
        let size = serde_json::to_vec(&value).map_or(usize::MAX, |bytes| bytes.len());
        if state.source_probes.contains_key(&key) {
            return;
        }
        if state.source_probes.len() >= 8
            || size
                > state
                    .probe_cache
                    .limit_bytes
                    .saturating_sub(state.probe_cache.retained_bytes)
        {
            state.probe_cache.bypasses += 1;
            return;
        }
        state.probe_cache.retained_bytes += size;
        state.source_probes.insert(key, value);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(value: &str) -> PaletteKey {
        vec![value.into()]
    }

    #[test]
    fn nested_stage_time_is_exclusive() {
        let mut state = State::new(0);
        let start = state.started;
        state.switch(Phase::Encode, start + Duration::from_micros(10));
        state.switch(Phase::Palette, start + Duration::from_micros(30));
        state.switch(Phase::Encode, start + Duration::from_micros(80));
        state.switch(Phase::Setup, start + Duration::from_micros(100));
        assert_eq!(micros(state.durations[Phase::Setup as usize]), 10);
        assert_eq!(micros(state.durations[Phase::Encode as usize]), 40);
        assert_eq!(micros(state.durations[Phase::Palette as usize]), 50);
        assert_eq!(
            state.durations.iter().sum::<Duration>(),
            Duration::from_micros(100)
        );
    }

    #[test]
    fn cache_obeys_byte_budget_and_never_substitutes_another_key() {
        let scope = PipelineScope::start(4);
        retain_palette(key("caption-a"), vec![1, 2, 3, 4]);
        retain_palette(key("caption-b"), vec![9]);
        assert_eq!(
            cached_palette(&key("caption-a")).unwrap().as_slice(),
            &[1, 2, 3, 4]
        );
        assert!(cached_palette(&key("caption-b")).is_none());
        assert_eq!(scope.report().palette_cache.retained_bytes, 4);
        assert_eq!(scope.report().palette_cache.bypasses, 1);
    }

    #[test]
    fn nested_exports_and_other_threads_do_not_share_palettes() {
        let outer = PipelineScope::start(8);
        retain_palette(key("same-source"), vec![1]);
        {
            let _inner = PipelineScope::start(8);
            assert!(cached_palette(&key("same-source")).is_none());
            retain_palette(key("same-source"), vec![2]);
        }
        assert_eq!(
            cached_palette(&key("same-source")).unwrap().as_slice(),
            &[1]
        );
        std::thread::spawn(|| assert!(cached_palette(&key("same-source")).is_none()))
            .join()
            .unwrap();
        drop(outer);
        assert!(cached_palette(&key("same-source")).is_none());
    }

    #[test]
    fn failed_export_unwinds_and_releases_its_cache() {
        let failure = std::panic::catch_unwind(|| {
            let _scope = PipelineScope::start(8);
            let _stage = stage(Phase::Palette);
            retain_palette(key("aborted"), vec![1]);
            panic!("simulated aborted worker");
        });
        assert!(failure.is_err());
        assert!(cached_palette(&key("aborted")).is_none());
        let next = PipelineScope::start(0);
        retain_palette(key("aborted"), vec![1]);
        assert!(cached_palette(&key("aborted")).is_none());
        assert_eq!(next.report().palette_cache.retained_bytes, 0);
    }

    #[test]
    fn cache_also_bounds_entry_count_and_does_not_serialize_keys() {
        let scope = PipelineScope::start(1000);
        for index in 0..40 {
            retain_palette(key(&format!("private-input-{index}")), vec![1]);
        }
        assert_eq!(scope.report().palette_cache.retained_bytes, 32);
        assert_eq!(scope.report().palette_cache.bypasses, 8);
        assert!(!serde_json::to_string(&scope.report())
            .unwrap()
            .contains("private-input"));
    }

    #[test]
    fn source_metadata_is_bounded_and_isolated_between_exports() {
        {
            let scope = PipelineScope::start(0);
            retain_source_probe(
                key("oversized"),
                serde_json::json!({"value": "x".repeat(65536)}),
            );
            assert!(cached_source_probe(&key("oversized")).is_none());
            for index in 0..10 {
                retain_source_probe(key(&index.to_string()), serde_json::json!({"width": index}));
            }
            assert_eq!(scope.report().source_probe_cache.bypasses, 3);
            assert!(cached_source_probe(&key("0")).is_some());
            assert!(!serde_json::to_string(&scope.report())
                .unwrap()
                .contains("oversized"));
        }
        let next = PipelineScope::start(0);
        assert!(cached_source_probe(&key("0")).is_none());
        assert_eq!(next.report().source_probe_cache.retained_bytes, 0);
    }
}
