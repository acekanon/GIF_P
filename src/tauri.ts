import { invoke } from "@tauri-apps/api/core";

export type GifEncoder = "ffmpeg_fast" | "pngquant_opt" | "hybrid" | "clean_opt";
export type GifGenerationMode = "fast_gif" | "best_gif" | "target_size";
export type PerceptualFocus = "auto" | "subject" | "motion" | "text_ui" | "flat_art";
export type TargetPreference = "auto" | "balanced" | "clarity" | "smoothness" | "smallest";
export type TargetConstraint = "hard_cap" | "symmetric_match";
export type FilterStyle =
  | "none"
  | "vivid"
  | "warm_skin"
  | "cool_tone"
  | "mono_contrast"
  | "vintage_film"
  | "soft_matte"
  | "comic_ink"
  | "gb"
  | "gba_lcd"
  | "crt"
  | "pixel";
export type OutputFormat = "gif" | "webp" | "avif" | "apng" | "mp4" | "webm" | "live_photo";
export type DeliveryIntent = "smart" | "compatibility" | "modern_animation" | "video" | "target_platform";
export type TargetPlatform = "chat" | "modern_web" | "transparent_ui" | "social_video";

export interface MemeOverlayRequest {
  top_text: string;
  bottom_text: string;
  style: "classic" | "panel" | "bubble" | "highlight" | "blackbar" | "cinema" | "news";
  font_size: number;
  text_align: "left" | "center" | "right";
  position: "split" | "center" | "lower" | "free";
  top_x: number;
  top_y: number;
  bottom_x: number;
  bottom_y: number;
  start_seconds?: number | null;
  end_seconds?: number | null;
}

export interface BackgroundRemovalRequest {
  mode: "off" | "color_key";
  key_color: string;
  similarity: number;
  edge_blend: number;
  despill: number;
}

export interface TrackedEffectKeyframeRequest {
  time_seconds: number;
  x_percent: number;
  y_percent: number;
  width_percent: number;
  height_percent: number;
  confidence: number;
}

export interface TrackedEffectRequest {
  effect_id: string;
  kind: "label" | "highlight" | "soft_blur" | "blackout";
  label: string;
  start_seconds: number;
  end_seconds: number;
  keyframes: TrackedEffectKeyframeRequest[];
}

export interface TrackMediaRegionRequest {
  input_path: string;
  start_seconds: number;
  end_seconds: number;
  sample_fps: number;
  max_frames: number;
  x_percent: number;
  y_percent: number;
  width_percent: number;
  height_percent: number;
}

export interface TrackMediaRegionKeyframe {
  time_seconds: number;
  x_percent: number;
  y_percent: number;
  width_percent: number;
  height_percent: number;
  confidence: number;
}

export interface TrackMediaRegionResult {
  model_id: string;
  frames_analyzed: number;
  average_confidence: number;
  low_confidence_frames: number;
  keyframes: TrackMediaRegionKeyframe[];
}

export interface CutoutPreviewRequest {
  input_path: string;
  time_seconds: number;
  max_width: number;
  settings: BackgroundRemovalRequest;
}

export interface CutoutPreviewResult {
  path: string;
  time_seconds: number;
  key_color: string;
}

export interface DeletedTimelineRange {
  start_seconds: number;
  end_seconds: number;
}

export type FrameTimingMode = "compact" | "preserve";

export interface GifRequest {
  smart_lossless?: boolean;
  temporal_stability?: boolean;
  lzw_search?: boolean;
  smaller_gif?: boolean;
  index_compression?: boolean;
  index_compression_gentle?: boolean;
  gif_merge_frames?: boolean;
  gif_compact_palette?: boolean;
  schema_version: 1;
  /** Stable identifier used to cancel an in-flight desktop conversion task. */
  task_id?: string;
  input_path: string;
  output_dir: string;
  width: number;
  fps: number;
  colors: number;
  dither: string;
  optimize_level: number;
  lossy: number;
  start_seconds: number;
  end_seconds: number;
  encoder: GifEncoder;
  filter_style: FilterStyle;
  loop_output: boolean;
  crop_enabled: boolean;
  crop_left: number;
  crop_top: number;
  crop_right: number;
  crop_bottom: number;
  deleted_frames: number[];
  deleted_ranges?: DeletedTimelineRange[];
  frame_timing_mode: FrameTimingMode;
  playback_speed: number;
  output_format: OutputFormat;
  generation_mode: GifGenerationMode;
  target_size_bytes: number | null;
  target_tolerance_percent: number;
  target_max_attempts: number;
  target_preference: TargetPreference;
  target_constraint: TargetConstraint;
  /** 5.6 Fast baseline reused as the first measured point of a tight-cap search. */
  fast_baseline_size_bytes?: number | null;
  bayer_scale: number;
  alpha_threshold: number;
  allow_experimental: boolean;
  perceptual_focus: PerceptualFocus;
  meme_overlay: MemeOverlayRequest | null;
  background_removal: BackgroundRemovalRequest | null;
  tracked_effects: TrackedEffectRequest[];
}

export interface GpuResourceSample {
  name: string;
  usage_percent: number;
  encoder_usage_percent: number | null;
}

export interface RuntimeResourceSnapshot {
  sampled_at_ms: number;
  cpu_usage_percent: number;
  app_cpu_usage_percent: number;
  logical_cpu_count: number;
  physical_cpu_count: number | null;
  total_memory_bytes: number;
  used_memory_bytes: number;
  app_memory_bytes: number;
  active_conversion_jobs: number;
  gpu_backend: "nvidia_smi" | "unavailable";
  gpus: GpuResourceSample[];
  gpu_unavailable_reason: string | null;
}

export interface PerceptualReport {
  analysis_frame_count: number;
  kept_frame_count: number;
  dropped_frame_count: number;
  kept_ratio: number;
  variable_delay_frames: number;
  source_duration_ms: number;
  output_duration_ms: number;
  scene_boundary_count: number;
  mean_motion: number;
  mean_changed_area: number;
  mean_edge_text: number;
  mean_noise: number;
  mean_smooth_gradient_ratio: number;
  mean_subject_saliency: number;
  mean_skin_ratio: number;
  focus: PerceptualFocus;
  filter_strategy: "neutral" | "temporal_cleanup" | "temporal_cleanup+color_eq" | "denoise_deband+color_eq";
  experimental_dither_candidate?: string | null;
  effective_dither: string;
  effective_bayer_scale?: number | null;
  static_gradient_writer_recommended?: boolean;
  structured_ui_mapper_candidate?: boolean;
  truncated: boolean;
  aggregate_timeline_verified: boolean;
}

export interface PaletteReport {
  planner_id: string;
  planner_version: string;
  color_space: "oklab";
  strategy: "global" | "segmented" | "segmented_local";
  requested_colors: number;
  emitted_colors: number;
  histogram_precision_bits: 5 | 6;
  reserved_transparent: boolean;
  segment_count: number;
  artifact_hashes: string[];
  sampled_frame_count: number;
  sampled_pixel_count: number;
  weighted_histogram_mean_oklab_error: number;
  weighted_histogram_p95_oklab_error: number;
  global_color_table_verified: boolean;
  candidate_status?: "not_needed" | "fit_gate_not_met" | "planned_not_encoded" | "segmentation_failed" | "planning_failed" | "encoded" | "quality_gate_rejected" | "selection_gate_rejected" | "candidate_failed";
  candidate_fallback_reason?: string | null;
  candidate_segment_count?: number;
  candidate_boundary_reasons?: Array<"hard_cut" | "color_drift" | "motion_shift">;
  candidate_artifact_hashes?: string[];
  shared_anchor_count?: number;
  shared_anchor_sha256?: string | null;
  segmentation_sha256?: string | null;
  palette_sequence_sha256?: string | null;
  candidate_weighted_mean_oklab_error?: number | null;
  candidate_worst_segment_p95_oklab_error?: number | null;
}

export interface RegionDitherReport {
  planner_id: string;
  planner_version: string;
  status: "planned_not_encoded" | "planning_failed" | "encoded" | "quality_gate_rejected" | "candidate_failed";
  fallback_reason?: string | null;
  grid_width: number;
  grid_height: number;
  sampled_frame_count: number;
  sampled_pixel_count: number;
  weighted_sample_mass?: number | null;
  class_counts: {
    flat: number;
    text_edge: number;
    skin_subject: number;
    texture: number;
  };
  mean_dither_strength?: number | null;
  mean_spatial_std?: number | null;
  mean_edge?: number | null;
  mean_skin_ratio?: number | null;
  mean_temporal_delta?: number | null;
  mean_high_frequency_noise?: number | null;
  class_map_sha256?: string | null;
  strength_map_sha256?: string | null;
  artifact_sha256?: string | null;
}

export interface IndexedGifWriterReport {
  writer_id: string;
  writer_version: string;
  container_backend: string;
  status: "encoded_default" | "encoded_experimental" | "baseline_retained" | "fallback_ffmpeg";
  fallback_reason?: string | null;
  frame_count: number;
  full_frame_count: number;
  total_indexed_pixels: number;
  original_indexed_pixels: number;
  optimized_indexed_pixels: number;
  rectangle_frame_count: number;
  transparent_hold_frame_count: number;
  background_disposal_frame_count: number;
  previous_disposal_frame_count: number;
  disposal_candidate_count: number;
  selected_disposal_strategy: string;
  indexed_pixel_reduction_percent: number;
  baseline_serialized_bytes?: number | null;
  candidate_serialized_bytes?: number | null;
  serialized_byte_reduction_percent?: number | null;
  disposal_simulation_verified: boolean;
  total_delay_cs: number;
  local_palette_frame_count: number;
  palette_boundary_full_frame_count: number;
  global_palette_rgb_sha256?: string | null;
  local_palette_sequence_sha256?: string | null;
  indexed_timeline_sha256?: string | null;
  ffmpeg_mapped_rgba_sha256?: string | null;
  writer_input_rgba_sha256?: string | null;
  decoded_rgba_sha256?: string | null;
  decoded_pixel_parity_verified: boolean;
  palette_compaction_report?: IndexedPaletteCompactionExecutionReport | null;
  palette_mapper_selection_report?: PaletteMapperSelectionReport | null;
  regional_quantizer_report?: RegionalQuantizerExecutionReport | null;
  segment_palette_report?: SegmentPaletteExecutionReport | null;
}

export interface IndexedPaletteCompactionExecutionReport {
  selector_id: string;
  selector_version: string;
  status:
    | "compacted_selected"
    | "baseline_retained"
    | "compacted_single_pass_no_byte_comparison";
  real_byte_comparison_performed: boolean;
  selection_gate_passed: boolean;
  /** Null when the uncompacted stream was intentionally not serialized. */
  baseline_serialized_bytes: number | null;
  compacted_serialized_bytes: number;
  selected_serialized_bytes: number;
  /** Null unless a real uncompacted byte stream was observed. */
  serialized_byte_reduction_percent: number | null;
  original_global_palette_entries: number;
  compacted_global_palette_entries: number;
  selected_global_palette_entries: number;
  original_local_palette_entries: number;
  compacted_local_palette_entries: number;
  compacted_local_palette_frame_count: number;
  remapped_frame_count: number;
  display_simulation_verified: boolean;
}

export interface PaletteMapperCandidateReport {
  histogram_precision_bits: 5 | 6;
  palette_sha256: string;
  emitted_colors: number;
  weighted_histogram_mean_oklab_error: number;
  weighted_histogram_p95_oklab_error: number;
  mapped_rgba_sha256: string;
  serialized_bytes: number;
  metrics: QuantizationMetricsReport;
}

export interface PaletteMapperSelectionReport {
  selector_id: string;
  selector_version: string;
  gate_id: string;
  status: "fine_selected" | "standard_retained";
  fallback_reason?: string | null;
  quality_gate_passed: boolean;
  selected_histogram_precision_bits: 5 | 6;
  selected_palette_sha256: string;
  baseline: PaletteMapperCandidateReport;
  candidate: PaletteMapperCandidateReport;
}

export interface ReleaseTrustReport {
  schema_version: number;
  context: "development" | "packaged";
  status: "verified" | "blocked" | "unverified";
  manifest_path: string;
  manifest_found: boolean;
  expected_product_version: string;
  reported_product_version: string | null;
  product_version_matches: boolean | null;
  actual_executable_name: string;
  reported_executable_name: string | null;
  executable_name_matches: boolean | null;
  actual_executable_sha256: string | null;
  reported_executable_sha256: string | null;
  executable_sha256_matches: boolean | null;
  source_dirty: boolean | null;
  channel: string | null;
  signature_status: string | null;
  signature_trusted: boolean | null;
  public_release_blockers: string[];
  runtime_integrity_status: "verified" | "failed" | "unverified";
  runtime_files_checked: number;
  runtime_failures: string[];
  reasons: string[];
}

export interface PaletteReservationCandidateReport {
  palette_sha256: string;
  reserved_transparent: boolean;
  usable_colors: number;
  emitted_colors: number;
  serialized_bytes: number;
  decoded_rgba_sha256: string;
  metrics: QuantizationMetricsReport;
  timing_metrics: TimingAwareTemporalResidualReport;
}

export interface PaletteReservationSelectionReport {
  selector_id: string;
  selector_version: string;
  gate_id: string;
  status: "opaque_256_selected" | "transparent_delta_retained" | "candidate_failed";
  fallback_reason?: string | null;
  quality_gate_passed: boolean;
  selected_route_id: "opaque_256_no_transdiff" | "transparent_255_transdiff";
  baseline?: PaletteReservationCandidateReport | null;
  candidate?: PaletteReservationCandidateReport | null;
}

export interface MotionPresentationMetricsReport {
  analysis_fps: number;
  sample_width: number;
  sample_height: number;
  compared_frames: number;
  mean_oklab_error: number;
  static_region_oklab_error: number;
  static_region_temporal_residual: number;
  static_pixel_ratio: number;
  edge_error: number;
  edge_preservation: number;
  edge_pixel_ratio: number;
}

export interface MotionDeliveryCandidateReport {
  route_id: "current_motion" | "neutral_bayer";
  filter_strategy: string;
  dither: string;
  bayer_scale?: number | null;
  serialized_bytes: number;
  decoded_rgba_sha256: string;
  metrics?: QuantizationMetricsReport | null;
  presentation_metrics?: MotionPresentationMetricsReport | null;
}

export interface MotionDeliveryContentSignalReport {
  signal_id: string;
  selection_role: "diagnostic_only";
  matched: boolean;
  mean_motion: number;
  mean_changed_area: number;
  mean_edge_text: number;
  mean_noise: number;
  mean_smooth_gradient_ratio: number;
  mean_skin_ratio: number;
}

export interface MotionDeliverySelectionReport {
  selector_id: string;
  selector_version: string;
  gate_id: string;
  status: "candidate_selected" | "baseline_retained" | "candidate_failed";
  fallback_reason?: string | null;
  quality_gate_passed: boolean;
  selected_route_id: "current_motion" | "neutral_bayer";
  content_signal?: MotionDeliveryContentSignalReport | null;
  baseline?: MotionDeliveryCandidateReport | null;
  candidate?: MotionDeliveryCandidateReport | null;
}

export interface QuantizationMetricsReport {
  sampled_pixel_count: number;
  sampled_static_pixel_count: number;
  mean_oklab_error: number;
  p95_oklab_error: number;
  edge_weighted_mean_oklab_error: number;
  multiscale_low_frequency_oklab_error: number;
  multiscale_banding_score: number;
  edge_gradient_error: number;
  static_temporal_residual: number;
  multiscale_static_temporal_residual: number;
}

export interface TimingAwareTemporalResidualReport {
  sampled_static_transition_count: number;
  weighted_static_sample_duration_cs: number;
  weighted_static_temporal_residual: number;
  sampled_multiscale_static_transition_count: number;
  weighted_multiscale_static_sample_duration_cs: number;
  weighted_multiscale_static_temporal_residual: number;
  loop_seam_sampled_static_pixel_count: number;
  loop_seam_static_temporal_residual?: number | null;
  loop_seam_sampled_multiscale_count: number;
  loop_seam_multiscale_static_temporal_residual?: number | null;
}

export interface RegionalQuantizerExecutionReport {
  quantizer_id: string;
  quantizer_version: string;
  gate_id: string;
  status: "encoded" | "quality_gate_rejected" | "candidate_failed";
  fallback_reason?: string | null;
  quality_gate_passed: boolean;
  selected_route_id?:
    | "ffmpeg_mapper"
    | "regional_ordered"
    | "temporal_hysteresis"
    | "phase_locked_pair_temporal"
    | "error_diffusion_temporal";
  temporal_selection?: TemporalQuantizerSelectionReport | null;
  phase_locked_pair_selection?: PhaseLockedPairSelectionReport | null;
  error_diffusion_selection?: ErrorDiffusionSelectionReport | null;
  candidate_metrics?: QuantizationMetricsReport | null;
  baseline_metrics?: QuantizationMetricsReport | null;
  candidate_serialized_bytes?: number | null;
  baseline_serialized_bytes?: number | null;
  secondary_choice_count: number;
  secondary_choice_by_class: [number, number, number, number];
  indices_sha256?: string | null;
  artifact_sha256?: string | null;
  /** Internal mapper candidates excluding FFmpeg baseline; separate from delivery attempts. */
  logical_candidate_count?: number;
  /** Real GIF serializations used to price internal candidates, excluding FFmpeg baseline. */
  serialization_count?: number;
  ordered_candidate_elapsed_ms?: number | null;
  temporal_candidate_elapsed_ms?: number | null;
  phase_locked_pair_candidate_elapsed_ms?: number | null;
  error_diffusion_candidate_elapsed_ms?: number | null;
}

export interface TemporalQuantizerCandidateReport {
  metrics: QuantizationMetricsReport;
  timing_metrics?: TimingAwareTemporalResidualReport | null;
  serialized_bytes: number;
  indices_sha256: string;
  artifact_sha256: string;
  temporal_hold_count: number;
  temporal_hold_by_class: [number, number, number, number];
  temporal_hold_duration_cs?: number;
  temporal_max_observed_hold_duration_cs?: number;
}

export interface TemporalQuantizerSelectionReport {
  selector_id: string;
  selector_version: string;
  gate_id: string;
  max_hold_frames: number;
  max_hold_duration_cs?: number;
  status:
    | "candidate_selected"
    | "selection_gate_rejected"
    | "quality_gate_rejected"
    | "candidate_failed";
  fallback_reason?: string | null;
  quality_gate_passed: boolean;
  selection_gate_passed: boolean;
  baseline: TemporalQuantizerCandidateReport;
  candidate?: TemporalQuantizerCandidateReport | null;
}

export interface ErrorDiffusionCandidateReport {
  spatial_kernel_id: string;
  kernel_config_sha256: string;
  fallback_route_id: string;
  fallback_indices_sha256: string;
  gradient_eligibility_mask_sha256: string;
  edge_protection_mask_sha256: string;
  max_hold_frames: number;
  max_hold_duration_cs: number;
  metrics: QuantizationMetricsReport;
  timing_metrics: TimingAwareTemporalResidualReport;
  serialized_bytes: number;
  indices_sha256: string;
  reconstructed_rgb24_sha256: string;
  artifact_sha256: string;
  indexed_timeline_sha256: string;
  serialized_gif_sha256: string;
  direct_gradient_eligible_cell_count: number;
  coherence_rescued_cell_count: number;
  coherence_rescued_pixel_count: number;
  pre_protection_gradient_pixel_count: number;
  gradient_eligible_pixel_count: number;
  protected_edge_seed_pixel_count: number;
  protected_edge_halo_pixel_count: number;
  protected_edge_fallback_pixel_count: number;
  protected_edge_index_change_count: number;
  diffused_pixel_count: number;
  diffused_pixel_by_class: [number, number, number, number];
  residual_clamp_count: number;
  cell_reset_count: number;
  fallback_preserved_pixel_count: number;
  eligible_index_change_count: number;
  ineligible_index_change_count: number;
  eligible_index_change_rate: number;
  frame_error_buffer_reset_count: number;
  residual_link_candidate_count: number;
  full_conductance_residual_link_count: number;
  cross_cell_candidate_link_count: number;
  cross_cell_propagated_link_count: number;
  cross_cell_rejected_class_count: number;
  cross_cell_rejected_eligibility_count: number;
  cross_cell_rejected_protection_count: number;
  cross_cell_blocked_hard_edge_count: number;
  protected_target_link_count: number;
  edge_guarded_pixel_count: number;
  attenuated_residual_link_count: number;
  blocked_residual_link_count: number;
  temporal_regularized_hold_count: number;
  temporal_prev_candidate_count: number;
  temporal_prev_rejected_by_color_count: number;
  temporal_prev_rejected_by_budget_count: number;
  temporal_prev_rejected_by_regularizer_count: number;
  temporal_vfr_single_frame_extension_count: number;
  loop_seeded_pixel_count: number;
  static_index_flip_count: number;
  vfr_weighted_static_index_flip_rate: number;
  temporal_hold_count: number;
  temporal_hold_by_class: [number, number, number, number];
  temporal_hold_duration_cs: number;
  temporal_max_observed_hold_duration_cs: number;
}

export interface ErrorDiffusionSelectionReport {
  selector_id: string;
  selector_version: string;
  gate_id: string;
  status:
    | "candidate_selected"
    | "selection_gate_rejected"
    | "quality_gate_rejected"
    | "candidate_failed";
  fallback_reason?: string | null;
  quality_gate_passed: boolean;
  selection_gate_passed: boolean;
  max_hold_frames: number;
  max_hold_duration_cs: number;
  spatial_kernel_id: string;
  kernel_config_sha256: string;
  source_rgb24_sha256: string;
  palette_sha256: string;
  region_dither_sha256: string;
  frame_delays_sha256: string;
  fallback_route_id: string;
  fallback_indices_sha256: string;
  input_contract_sha256: string;
  ffmpeg_baseline_metrics: QuantizationMetricsReport;
  ffmpeg_baseline_timing_metrics: TimingAwareTemporalResidualReport;
  ffmpeg_baseline_serialized_bytes: number;
  ffmpeg_baseline_indexed_timeline_sha256: string;
  ffmpeg_baseline_serialized_gif_sha256: string;
  comparison_route_id: string;
  comparison_metrics: QuantizationMetricsReport;
  comparison_timing_metrics: TimingAwareTemporalResidualReport;
  comparison_serialized_bytes: number;
  candidate?: ErrorDiffusionCandidateReport | null;
}

export interface PhaseLockedPairCandidateReport {
  spatial_kernel_id: string;
  kernel_config_sha256: string;
  fallback_route_id: string;
  fallback_indices_sha256: string;
  pair_lookup_sha256: string;
  eligibility_mask_sha256: string;
  edge_protection_mask_sha256: string;
  max_hold_frames: number;
  max_hold_duration_cs: number;
  metrics: QuantizationMetricsReport;
  timing_metrics: TimingAwareTemporalResidualReport;
  /** Missing when the candidate is rejected before its single allowed write. */
  serialized_bytes?: number | null;
  indices_sha256: string;
  reconstructed_rgb24_sha256: string;
  artifact_sha256: string;
  indexed_timeline_sha256?: string | null;
  serialized_gif_sha256?: string | null;
  opaque_fallback_pixel_count: number;
  transparent_fallback_pixel_count: number;
  smooth_region_pixel_count: number;
  protected_edge_pixel_count: number;
  non_micro_change_fallback_pixel_count: number;
  scene_cut_fallback_pixel_count: number;
  no_bracketing_pair_fallback_pixel_count: number;
  eligible_pixel_count: number;
  paired_pixel_count: number;
  pair_candidate_count: number;
  changed_pixel_count: number;
  changed_pixel_by_class: [number, number, number, number];
  fallback_preserved_pixel_count: number;
  protected_edge_index_change_count: number;
  ineligible_index_change_count: number;
  skin_pair_hue_rejection_count: number;
  skin_pair_chroma_rejection_count: number;
  temporal_candidate_count: number;
  temporal_hold_count: number;
  temporal_hold_by_class: [number, number, number, number];
  temporal_hold_duration_cs: number;
  temporal_max_observed_hold_duration_cs: number;
  temporal_rejected_by_pair_count: number;
  temporal_rejected_by_color_count: number;
  temporal_rejected_by_budget_count: number;
  cut_reset_pixel_count: number;
  loop_seeded_pixel_count: number;
  fallback_static_index_flip_count: number;
  static_index_flip_count: number;
  fallback_vfr_weighted_static_index_flip_rate: number;
  vfr_weighted_static_index_flip_rate: number;
  fallback_loop_seam_static_index_flip_count: number;
  loop_seam_static_index_flip_count: number;
  stored_frame_early_reject_count: number;
  pre_reject_changed_pixel_count: number;
  pre_reject_temporal_hold_count: number;
  fallback_mean_oklab_error: number;
  candidate_mean_oklab_error: number;
  fallback_multiscale_banding_score: number;
  candidate_multiscale_banding_score: number;
}

export interface PhaseLockedPairSelectionReport {
  selector_id: string;
  selector_version: string;
  gate_id: string;
  status:
    | "candidate_selected"
    | "selection_gate_rejected"
    | "quality_gate_rejected"
    | "candidate_failed"
    | "candidate_skipped";
  fallback_reason?: string | null;
  quality_gate_passed: boolean;
  selection_gate_passed: boolean;
  max_hold_frames: number;
  max_hold_duration_cs: number;
  spatial_kernel_id: string;
  kernel_config_sha256: string;
  source_rgb24_sha256: string;
  palette_sha256: string;
  region_dither_sha256: string;
  frame_delays_sha256: string;
  fallback_route_id: string;
  fallback_indices_sha256: string;
  input_contract_sha256: string;
  ffmpeg_baseline_metrics: QuantizationMetricsReport;
  ffmpeg_baseline_timing_metrics: TimingAwareTemporalResidualReport;
  ffmpeg_baseline_serialized_bytes: number;
  ffmpeg_baseline_indexed_timeline_sha256: string;
  ffmpeg_baseline_serialized_gif_sha256: string;
  comparison_route_id: string;
  comparison_metrics: QuantizationMetricsReport;
  comparison_timing_metrics: TimingAwareTemporalResidualReport;
  comparison_serialized_bytes: number;
  candidate?: PhaseLockedPairCandidateReport | null;
}

export interface SegmentPaletteExecutionReport {
  planner_id: string;
  planner_version: string;
  gate_id: string;
  selection_gate_id: string;
  status: "encoded" | "quality_gate_rejected" | "selection_gate_rejected" | "candidate_failed";
  fallback_reason?: string | null;
  quality_gate_passed: boolean;
  selection_gate_passed: boolean;
  segment_count: number;
  candidate_metrics?: QuantizationMetricsReport | null;
  baseline_metrics?: QuantizationMetricsReport | null;
  candidate_serialized_bytes?: number | null;
  baseline_serialized_bytes?: number | null;
  opaque_colors_by_segment: number[];
  local_table_entries_by_segment: number[];
  local_palette_frame_count: number;
  palette_boundary_full_frame_count: number;
  palette_sequence_sha256?: string | null;
}

export interface TargetObservationReport {
  attempt: number;
  width: number;
  fps: number;
  colors: number;
  bayer_scale: number;
  size_bytes: number;
  symmetric_deviation_percent: number;
  under_target: boolean;
  within_tolerance: boolean;
  pareto_frontier: boolean;
  selected: boolean;
}

export interface TargetRecommendationReport {
  role: "clearest" | "smoothest" | "smallest";
  attempt: number;
}

export interface TargetRoutePredictionReport {
  model_id: string;
  source_route_id: string;
  source_size_bytes: number;
  predicted_size_bytes: number;
  actual_to_predicted_ratio: number | null;
  correction_pass: number;
}

export interface TargetRouteObservationReport {
  route_id: string;
  timeline: "cfr" | "perceptual_drop_hold";
  width: number;
  fps: number;
  colors: number;
  dither: string;
  palette_stats_mode: string;
  size_bytes: number | null;
  symmetric_deviation_percent: number | null;
  under_target: boolean;
  within_tolerance: boolean;
  selected: boolean;
  kept_frame_count: number | null;
  dropped_frame_count: number | null;
  timeline_verified: boolean;
  prediction?: TargetRoutePredictionReport | null;
  status: "encoded" | "failed";
  failure_reason: string | null;
}

export interface TargetOptimizerReport {
  optimizer_id: string;
  optimizer_version: string;
  selection_policy: string;
  constraint: TargetConstraint;
  preference: "balanced" | "clarity" | "smoothness" | "smallest";
  target_bytes: number;
  tolerance_percent: number;
  max_attempts: number;
  numeric_attempt_count: number;
  route_attempt_count: number;
  selected_attempt: number;
  route_probe_id: string;
  selected_route_id: string;
  observations: TargetObservationReport[];
  recommendations: TargetRecommendationReport[];
  route_observations: TargetRouteObservationReport[];
}

export interface PipelineProfile {
  schema_version: number;
  scope: "encode_only_exclusive_wall_time";
  elapsed_us: number;
  stages: Array<{ stage: string; calls: number; elapsed_us: number }>;
  palette_cache: {
    limit_bytes: number;
    retained_bytes: number;
    hits: number;
    misses: number;
    bypasses: number;
  };
  source_probe_cache?: {
    limit_bytes: number;
    retained_bytes: number;
    hits: number;
    misses: number;
    bypasses: number;
  };
}

export interface AdvancedCompressionStageReport {
  method: "temporal_stability" | "lzw_cost_search";
  status: "adopted" | "not_selected" | "no_gain" | "rejected" | "skipped" | "budget_exhausted";
  before_bytes: number;
  candidate_bytes?: number | null;
  writer_control_bytes?: number | null;
  algorithm_saved_bytes: number;
  adopted: boolean;
  verified: boolean;
  compression_probes: number;
  changed_pixels: number;
  elapsed_ms: number;
  reason?: string | null;
  metrics?: unknown;
}

export interface AdvancedCompressionExecutionReport {
  algorithm_version: string;
  status: "optimized" | "retained";
  before_bytes: number;
  after_bytes: number;
  adopted: boolean;
  verified: boolean;
  reference_kind: "prequantized_source" | "gif_only" | "unavailable";
  elapsed_ms: number;
  estimated_peak_bytes: number;
  reason?: string | null;
  stages: AdvancedCompressionStageReport[];
}

export interface GifResult {
  advanced_compression_report?: AdvancedCompressionExecutionReport | null;
  structure_optimization_report?: {
    status: string;
    before_bytes: number;
    after_bytes: number;
    adopted: boolean;
    verified: boolean;
    method: string;
    compression_probes: number;
    palette_boundary_rectangles: number;
    frame_count: number;
    estimated_peak_bytes: number;
    elapsed_ms: number;
    reason: string | null;
  } | null;
  gif_cleanup_report?: {
    status: string;
    before_bytes: number;
    after_bytes: number;
    verified: boolean;
    merged_frames: number;
    removed_palette_entries: number;
    merge_requested: boolean;
    palette_requested: boolean;
    elapsed_ms: number;
    reason: string | null;
  } | null;
  index_compression_report?: {
    gentle?: boolean;
    algorithm: string;
    status: string;
    before_bytes: number;
    after_bytes: number;
    verified: boolean;
    threshold: number;
    max_channel_error: number;
    worst_frame_rmse: number;
    candidates_tested: number;
    elapsed_ms: number;
    reason: string | null;
  } | null;
  postprocess_report?: {
    status: string;
    before_bytes: number;
    after_bytes: number;
    verified: boolean;
    elapsed_ms: number;
    reason: string | null;
  } | null;
  pipeline_profile?: PipelineProfile | null;
  input_path: string;
  output_path: string;
  size_bytes: number;
  encoder_used: string;
  status: string;
  backend_id: string;
  backend_version: string | null;
  ffmpeg_engine_version?: string | null;
  fallback_reason: string | null;
  palette_strategy: string;
  attempts: number;
  elapsed_ms: number;
  output_width: number;
  output_fps: number;
  effective_output_fps?: number | null;
  output_frame_count: number;
  output_colors: number;
  output_format?: OutputFormat;
  output_codec?: string;
  output_has_alpha?: boolean;
  target_size_bytes: number | null;
  target_deviation_percent: number | null;
  warnings: string[];
  perceptual_report?: PerceptualReport | null;
  palette_report?: PaletteReport | null;
  region_dither_report?: RegionDitherReport | null;
  indexed_gif_writer_report?: IndexedGifWriterReport | null;
  motion_delivery_selection_report?: MotionDeliverySelectionReport | null;
  palette_reservation_selection_report?: PaletteReservationSelectionReport | null;
  target_optimizer_report?: TargetOptimizerReport | null;
  live_photo?: LivePhotoResult | null;
  quality_report?: OutputQualityReport | null;
}

export interface OutputQualityReport {
  status: "measured" | "unavailable";
  metric_model: string;
  sample_duration_seconds: number;
  compared_frames: number;
  vmaf_mean: number | null;
  vmaf_p05: number | null;
  ssim_mean: number | null;
  ms_ssim_mean: number | null;
  elapsed_ms: number;
  message: string | null;
}

export interface OutputQualityRequest {
  encode_request: GifRequest;
  output_path: string;
}

export type LivePhotoCompatibilityStatus = "locally_verified" | "unverified" | "failed";

/**
 * A Live Photo is more than two files with matching names. The backend must
 * verify the shared asset identifier and Apple pairing metadata before the UI
 * can describe the pair as compatible.
 */
export interface LivePhotoResult {
  still_path: string;
  motion_path: string;
  still_size_bytes?: number | null;
  motion_size_bytes?: number | null;
  asset_identifier?: string | null;
  asset_identifier_verified: boolean;
  metadata_pairing_verified: boolean;
  compatibility_status: LivePhotoCompatibilityStatus;
  validation_scope: "local_contract";
  validation_message?: string | null;
  report_schema_version?: number | null;
  still_time_movie_units?: number | null;
  movie_timescale?: number | null;
  video_track_id?: number | null;
  metadata_track_id?: number | null;
  metadata_sample_offset?: number | null;
  jpeg_sha256?: string | null;
  mov_sha256?: string | null;
  contract_sha256?: string | null;
}

export type BackendStatus =
  | { state: "available"; executable_path: string | null; version: string | null }
  | { state: "unavailable"; reason: string }
  | { state: "planned"; reason: string };

export interface BackendCapability {
  schema_version: number;
  id: string;
  display_name: string;
  kind: "encoder" | "post_processor";
  status: BackendStatus;
  distribution: "system" | "sidecar" | "external_only" | "built_in";
  license: string;
  license_notice: string | null;
  experimental: boolean;
  user_opt_in_required: boolean;
  modes: GifGenerationMode[];
  formats: OutputFormat[];
  features: {
    gif_encoding: boolean;
    postprocessing: boolean;
    perceptual_quantization: boolean;
    size_search_compatible: boolean;
    alpha: boolean;
    variable_frame_delays: boolean;
    partial_frame_rectangles: boolean;
    stdin_frame_stream: boolean;
    palette_controls: boolean;
    per_frame_palettes: boolean;
    subtitle_overlay: boolean;
    background_keying: boolean;
    production_filter_chain: boolean;
    production_io_chain: boolean;
    screen_capture_chain: boolean;
  };
}

export interface MergeGifRequest {
  input_paths: string[];
  output_dir: string;
  width: number;
  fps: number;
  colors: number;
  image_seconds: number;
  loop_output: boolean;
}

export interface ScreenRecordRequest {
  output_dir: string;
  fps: number;
  region_enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  capture_backend: "auto" | "gdigrab" | "ddagrab" | "psgrab";
}

export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  screen_x?: number;
  screen_y?: number;
  screen_width?: number;
  screen_height?: number;
}

export interface MediaThumbnailRequest {
  input_path: string;
  times: number[];
}

export interface MediaThumbnailFrame {
  time: number;
  path: string;
}

export interface FramePageRequest {
  input_path: string;
  start_seconds: number;
  end_seconds: number;
  playback_speed: number;
  fps: number;
  page_start: number;
  page_size: number;
  max_width?: number;
}

export interface FramePageThumbnail {
  index: number;
  time: number;
  path: string;
}

export interface FramePageResult {
  frames: FramePageThumbnail[];
  total_frames: number;
  page_start: number;
  page_size: number;
}

export interface MediaInspection {
  codec: string;
  width: number;
  height: number;
  duration: number;
  frame_count: number;
  animated: boolean;
  has_alpha: boolean;
}

export async function selectVideos(): Promise<string[]> {
  return invoke<string[]>("select_videos");
}

export async function selectOutputDir(): Promise<string | null> {
  return invoke<string | null>("select_output_dir");
}

export async function selectScreenRegion(): Promise<ScreenRegion | null> {
  return invoke<ScreenRegion | null>("select_screen_region");
}

export async function convertGif(request: GifRequest): Promise<GifResult> {
  return invoke<GifResult>("convert_gif", { request });
}

export async function convertAnimation(request: GifRequest): Promise<GifResult> {
  return invoke<GifResult>("convert_animation", { request });
}

export async function cancelConversionTask(taskId: string): Promise<boolean> {
  return invoke<boolean>("cancel_conversion_task", { taskId });
}

export interface DynamicPosterSlotRequest {
  input_path: string;
  x_percent: number;
  y_percent: number;
  width_percent: number;
  height_percent: number;
}

export interface DynamicPosterRequest {
  background_path: string | null;
  output_dir: string;
  width: number;
  height: number;
  fps: number;
  duration_seconds: number;
  title: string;
  subtitle: string;
  accent: "violet" | "mint" | "coral";
  export_mode: "gif_webp" | "gif" | "webp";
  slots: DynamicPosterSlotRequest[];
}

export interface DynamicPosterOutput {
  format: "gif" | "webp";
  path: string;
  size_bytes: number;
}

export interface DynamicPosterResult {
  outputs: DynamicPosterOutput[];
  elapsed_ms: number;
}

export async function evaluateOutputQuality(request: OutputQualityRequest): Promise<OutputQualityReport> {
  return invoke<OutputQualityReport>("evaluate_output_quality", { request });
}

export async function inspectMedia(inputPath: string): Promise<MediaInspection> {
  return invoke<MediaInspection>("inspect_media", { inputPath });
}

export async function listEncoderCapabilities(): Promise<BackendCapability[]> {
  return invoke<BackendCapability[]>("list_encoder_capabilities");
}

export async function getRuntimeResourceSnapshot(): Promise<RuntimeResourceSnapshot> {
  return invoke<RuntimeResourceSnapshot>("get_runtime_resource_snapshot");
}

export async function generateCutoutPreview(request: CutoutPreviewRequest): Promise<CutoutPreviewResult> {
  return invoke<CutoutPreviewResult>("generate_cutout_preview", { request });
}

export async function getReleaseTrust(): Promise<ReleaseTrustReport> {
  return invoke<ReleaseTrustReport>("get_release_trust");
}

export async function generateMediaThumbnails(request: MediaThumbnailRequest): Promise<MediaThumbnailFrame[]> {
  return invoke<MediaThumbnailFrame[]>("generate_media_thumbnails", { request });
}

export async function generateFramePage(request: FramePageRequest): Promise<FramePageResult> {
  return invoke<FramePageResult>("generate_frame_page", { request });
}

export async function trackMediaRegion(request: TrackMediaRegionRequest): Promise<TrackMediaRegionResult> {
  return invoke<TrackMediaRegionResult>("track_media_region", { request });
}

export async function mergeGif(request: MergeGifRequest): Promise<GifResult> {
  return invoke<GifResult>("merge_gif", { request });
}

export async function renderDynamicPoster(request: DynamicPosterRequest): Promise<DynamicPosterResult> {
  return invoke<DynamicPosterResult>("render_dynamic_poster", { request });
}

export async function openDirectory(path: string): Promise<void> {
  return invoke<void>("open_directory", { path });
}

export async function startScreenRecording(request: ScreenRecordRequest): Promise<string> {
  return invoke<string>("start_screen_recording", { request });
}

export async function stopScreenRecording(): Promise<string> {
  return invoke<string>("stop_screen_recording");
}
