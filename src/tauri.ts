import { invoke } from "@tauri-apps/api/core";

export type GifEncoder = "ffmpeg_fast" | "pngquant_opt" | "hybrid" | "clean_opt";
export type FilterStyle = "none" | "vivid" | "gb" | "gba_lcd" | "crt" | "pixel";

export interface GifRequest {
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
}

export interface GifResult {
  input_path: string;
  output_path: string;
  size_bytes: number;
  encoder_used: string;
  status: string;
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

export async function startScreenRecording(request: ScreenRecordRequest): Promise<string> {
  return invoke<string>("start_screen_recording", { request });
}

export async function stopScreenRecording(): Promise<string> {
  return invoke<string>("stop_screen_recording");
}
