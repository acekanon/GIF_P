import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { GifCompressionOptions, type GifCompressionSwitches } from "./GifCompressionOptions";
import { buildGifRequest } from "./editorModel";

afterEach(cleanup);
const initial: GifCompressionSwitches = { mergeFrames:false, compactPalette:false, smallerGif:false, indexCompression:false, gentleIndex:false };
function Harness() {
  const [value,setValue] = useState(initial);
  return <GifCompressionOptions value={value} optimizerReady={false} onChange={(key,checked)=>setValue(current=>({...current,[key]:checked}))} onReset={()=>setValue(initial)} />;
}
it("keeps unavailable switches inert and resets only the compression group", () => {
  render(<Harness />);
  expect(screen.getByRole("switch",{name:"温和模式"})).toBeDisabled();
  fireEvent.click(screen.getByRole("switch",{name:"温和模式"}));
  expect(screen.getByRole("status")).toHaveTextContent("已启用 0 项");
  fireEvent.click(screen.getByRole("switch",{name:"合并重复帧"}));
  fireEvent.click(screen.getByRole("switch",{name:"索引压缩"}));
  fireEvent.click(screen.getByRole("switch",{name:"温和模式"}));
  expect(screen.getByRole("status")).toHaveTextContent("已启用 3 项");
  expect(screen.getByRole("switch",{name:"更小优先"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{name:"恢复默认"}));
  expect(screen.getByRole("status")).toHaveTextContent("已启用 0 项");
  for (const input of screen.getAllByRole("switch")) expect(input).not.toBeChecked();
});
it("serializes only active GIF controls and leaves dimensions and cadence intact", () => {
  const base={inputPath:"C:/input.mp4",outputDir:"C:/output",presetId:"custom" as const,playbackSpeed:1,loopOutput:true,crop:{left:0,top:0,right:0,bottom:0},startSeconds:0,endSeconds:5,deletedFrames:[],overrides:{width:854,fps:12},mergeGifFrames:true,compactGifPalette:true,gentleIndex:true,indexCompression:true};
  expect(buildGifRequest({...base,smartLossless:true})).toMatchObject({width:854,fps:12,smart_lossless:true,gif_merge_frames:true,gif_compact_palette:true,index_compression:true,index_compression_gentle:true});
  expect(buildGifRequest({...base,indexCompression:false})).not.toHaveProperty("index_compression_gentle");
  const webp=buildGifRequest({...base,smartLossless:true,outputFormat:"webp"});
  for (const field of ["smart_lossless","gif_merge_frames","gif_compact_palette","index_compression","index_compression_gentle"]) expect(webp).not.toHaveProperty(field);
});
