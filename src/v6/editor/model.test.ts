import { describe, expect, it } from "vitest";
import {
  addAsset, addClip, addMediaLayer, addTextLayer, assertProject, clipDurationUs, clipStartUs, commitHistory, createHistory, createProject,
  DEFAULT_TRANSFORM, deleteFrame, duplicateClip, duplicateFrame, frameBoundaryUs, frameIndexAt, freezeClip, freezeFrame, isolateFrame, mediaSourceTimeAt, moveClip,
  projectDurationUs, PROJECT_LIMITS, redoHistory, relinkAsset, removeClip, removeKeyframe, setClipRate, sourceTimeAt, splitAtPlayhead, splitClip, stepFrame,
  timelineEntries, toggleClipReverse, transformAt, trimClip, undoHistory, updateClip, updateLayer, updateProject, upsertKeyframe,
} from "./model";
import type { EditProject, ProjectLayer, ProjectMediaLayer } from "./types";
import { parseProject, serializeProject } from "./persistence";

function fixture(durationUs = 1_000_000, rate = 1, reverse = false): EditProject {
  let p = createProject("测试");
  p = updateProject(p, { canvas: { ...p.canvas, fps: 30 } });
  p = addAsset(p, { id: "asset-a", path: "D:\\source.mp4", name: "source", kind: "video", width: 640, height: 480, durationUs });
  return addClip(p, "asset-a", { id: "clip-a", rate, reverse });
}

describe("integer timeline and source mapping", () => {
  it("normalizes only rate-induced rounding on aligned clips and restores their frame counts", () => {
    for(const fps of [30,60]) for(const startFrame of [0,1,2]) for(const length of [1,2,4]) for(const rate of [.5,2]) {
      if(!Number.isInteger(length/rate)) continue;
      let p=fixture(frameBoundaryUs(20,fps)); p=updateProject(p,{canvas:{...p.canvas,fps}});
      if(startFrame) p=splitAtPlayhead(p,frameBoundaryUs(startFrame,fps));
      p=splitAtPlayhead(p,frameBoundaryUs(startFrame+length,fps));
      const id=timelineEntries(p).find(entry=>entry.startUs===frameBoundaryUs(startFrame,fps))!.clip.id;
      const sped=setClipRate(p,id,rate,"ripple"),entry=timelineEntries(sped).find(item=>item.clip.id===id)!;
      expect(entry.endUs).toBe(frameBoundaryUs(startFrame+length/rate,fps));
      expect(projectDurationUs(sped)).toBe(frameBoundaryUs(20-length+length/rate,fps));
      const restored=setClipRate(sped,id,1,"ripple"); expect(projectDurationUs(restored)).toBe(frameBoundaryUs(20,fps));
      expect(timelineEntries(restored).find(item=>item.clip.id===id)?.endUs).toBe(frameBoundaryUs(startFrame+length,fps));
    }
    let p=fixture(frameBoundaryUs(10,60)); p=updateProject(p,{canvas:{...p.canvas,fps:60}}); p=splitAtPlayhead(p,frameBoundaryUs(1,60));
    expect(clipDurationUs(setClipRate(p,p.clips[0].id,.5).clips[0])).toBe(33333);
    expect(clipDurationUs(updateClip(p,p.clips[0].id,{rate:.5,durationUs:33334}).clips[0])).toBe(33334);
    expect(clipDurationUs(updateClip(p,p.clips[0].id,{rate:.5,outUs:16666}).clips[0])).toBe(33332);
  });
  it("duplicates a four-frame 60 fps clip into fourteen total frames, then removes it exactly", () => {
    let p=fixture(frameBoundaryUs(10,60)); p=updateProject(p,{canvas:{...p.canvas,fps:60}}); p=splitAtPlayhead(p,frameBoundaryUs(4,60));
    for(const policy of ["absolute","ripple"] as const) {
      const copied=duplicateClip(p,p.clips[0].id,policy);
      expect(projectDurationUs(copied)).toBe(233333);
      expect(frameIndexAt(projectDurationUs(copied)-1,60)+1).toBe(14);
      expect(timelineEntries(copied).map(entry=>[entry.startUs,entry.endUs])).toEqual([[0,66667],[66667,133333],[133333,233333]]);
      expect(copied.clips[1]).toMatchObject({inUs:p.clips[0].inUs,outUs:p.clips[0].outUs,durationUs:66666});
      const restored=removeClip(copied,copied.clips[1].id,policy);
      expect(projectDurationUs(restored)).toBe(frameBoundaryUs(10,60));
      expect(restored.clips.map(c=>[c.inUs,c.outUs])).toEqual(p.clips.map(c=>[c.inUs,c.outUs]));
    }
  });
  it("keeps frame-aligned clip insertions and removals exact at every 30/60 fps rounding phase", () => {
    for(const fps of [30,60]) for(const startFrame of [0,1,2]) for(const length of [1,2,4]) {
      let p=fixture(frameBoundaryUs(20,fps)); p=updateProject(p,{canvas:{...p.canvas,fps}});
      if(startFrame) p=splitAtPlayhead(p,frameBoundaryUs(startFrame,fps));
      p=splitAtPlayhead(p,frameBoundaryUs(startFrame+length,fps));
      p=addMediaLayer(p,"asset-a"); p=updateLayer(p,p.layers[0].id,{name:"aligned",sourceOffsetUs:33333.125});
      const id=timelineEntries(p).find(entry=>entry.startUs===frameBoundaryUs(startFrame,fps))!.clip.id;
      const copied=duplicateClip(p,id,"ripple"),removed=removeClip(p,id,"ripple");
      expect(projectDurationUs(copied)).toBe(frameBoundaryUs(20+length,fps)); expect(projectDurationUs(removed)).toBe(frameBoundaryUs(20-length,fps));
      const sourceIndices=Array.from({length:20},(_,i)=>i),endFrame=startFrame+length;
      const cases:[EditProject,number[]][]=[
        [copied,[...sourceIndices.slice(0,endFrame),...sourceIndices.slice(startFrame,endFrame),...sourceIndices.slice(endFrame)]],
        [removed,[...sourceIndices.slice(0,startFrame),...sourceIndices.slice(endFrame)]],
      ];
      for(const [edited,indices] of cases) for(let frame=0;frame<indices.length;frame++) {
        const time=frameBoundaryUs(frame,fps),layer=activeLayer(edited,"aligned",time) as ProjectMediaLayer;
        expect(mediaSourceTimeAt(layer,time-layer.startUs)).toBe(33333.125+frameBoundaryUs(indices[frame],fps));
      }
    }
  });
  it("retimes later clips and layers when a property's old and new tail are frame boundaries", () => {
    let p=fixture(frameBoundaryUs(10,60)); p=updateProject(p,{canvas:{...p.canvas,fps:60}}); p=splitAtPlayhead(p,frameBoundaryUs(4,60));
    p=addMediaLayer(p,"asset-a",frameBoundaryUs(4,60),frameBoundaryUs(10,60));
    p=updateLayer(p,p.layers[0].id,{name:"tail",sourceOffsetUs:100000});
    const grown=updateClip(p,p.clips[0].id,{durationUs:frameBoundaryUs(8,60)},"ripple");
    expect(projectDurationUs(grown)).toBe(frameBoundaryUs(14,60));
    expect(timelineEntries(grown)[1]).toMatchObject({startUs:frameBoundaryUs(8,60),endUs:frameBoundaryUs(14,60)});
    for(let frame=8;frame<14;frame++) {
      const time=frameBoundaryUs(frame,60),layer=activeLayer(grown,"tail",time) as ProjectMediaLayer;
      expect(mediaSourceTimeAt(layer,time-layer.startUs)).toBe(100000+frameBoundaryUs(frame-4,60)-frameBoundaryUs(4,60));
    }
    const shrunk=updateClip(grown,grown.clips[0].id,{durationUs:frameBoundaryUs(4,60)},"ripple");
    expect(projectDurationUs(shrunk)).toBe(frameBoundaryUs(10,60));
    expect(shrunk.layers[0].startUs).toBe(frameBoundaryUs(4,60));
  });
  it("splits a reversed, slowed clip without losing duration or reversing source bounds", () => {
    const p = fixture(1_000_003, .3, true), duration = projectDurationUs(p);
    const next = splitClip(p, "clip-a", 1_111_111);
    expect(next.clips).toHaveLength(2);
    expect(next.clips[0].inUs).toBe(next.clips[1].outUs);
    expect(next.clips[0].outUs).toBe(1_000_003);
    expect(next.clips[1].inUs).toBe(0);
    expect(next.clips.map(clipDurationUs)).toEqual([1_111_111, duration - 1_111_111]);
    expect(projectDurationUs(next)).toBe(duration);
    expect(sourceTimeAt(next.clips[0], clipDurationUs(next.clips[0]))).toBe(sourceTimeAt(next.clips[1], 0));
    expect(p.clips).toHaveLength(1);
  });
  it("preserves exact total across hundreds of output-frame splits", () => {
    let p = fixture(10_000_003, .7, true); const duration = projectDurationUs(p);
    for (let frame = 1; frame < 400; frame++) p = splitAtPlayhead(p, frameBoundaryUs(frame, 30));
    expect(projectDurationUs(p)).toBe(duration);
    expect(p.clips.slice(0, 399).map(clipDurationUs).reduce((a, b) => a + b, 0)).toBe(frameBoundaryUs(399, 30));
    for (let i = 1; i < p.clips.length; i++) expect(p.clips[i - 1].inUs).toBe(p.clips[i].outUs);
  });
  it("does not accumulate rounded frame periods, including NTSC rates", () => {
    expect([0, 1, 2, 3].map(i => frameBoundaryUs(i, 30))).toEqual([0, 33333, 66667, 100000]);
    for (const fps of [15, 30, 60, 30000 / 1001]) for (const frame of [1, 2, 1000, 30000]) {
      const boundary = frameBoundaryUs(frame, fps);
      expect(frameIndexAt(boundary, fps)).toBe(frame);
      expect(frameIndexAt(boundary - 1, fps)).toBe(frame - 1);
    }
    expect(frameBoundaryUs(30000, 30000 / 1001)).toBe(1_001_000_000);
  });
  it("handles no-op boundaries and rejects invalid split positions", () => {
    const p = fixture(); expect(splitClip(p, "clip-a", 0)).toBe(p); expect(splitAtPlayhead(p, 1_000_000)).toBe(p);
    expect(() => splitClip(p, "clip-a", 1_000_001)).toThrow(); expect(() => splitAtPlayhead(p, 1.3)).toThrow();
  });
  it("recomputes an explicit span after changing rate or trim, without changing reverse", () => {
    let p = splitClip(fixture(1_000_003, .7, true), "clip-a", 100_000);
    const sourceSpan = p.clips[0].outUs - p.clips[0].inUs;
    p = setClipRate(p, "clip-a", 2); expect(clipDurationUs(p.clips[0])).toBe(Math.round(sourceSpan / 2));
    p = trimClip(p, "clip-a", 1, 400_001); expect(clipDurationUs(p.clips[0])).toBe(200_000); expect(p.clips[0].reverse).toBe(true);
  });
  it("derives contiguous starts from order for reorder and duplication", () => {
    let p = splitClip(fixture(), "clip-a", 200_000); p = duplicateClip(p, "clip-a");
    const duplicate = p.clips[1]; p = moveClip(p, duplicate.id, 2);
    expect(timelineEntries(p).map(e => [e.startUs, e.endUs])).toEqual([[0, 200_000], [200_000, 1_000_000], [1_000_000, 1_200_000]]);
    expect(clipStartUs(p, duplicate.id)).toBe(1_000_000);
  });
});

describe("preserved transform samples", () => {
  function posedProject(fps:number,media:boolean) {
    const duration=frameBoundaryUs(10,fps); let p=fixture(duration); p=updateProject(p,{canvas:{...p.canvas,fps}});
    p=media ? addMediaLayer(p,"asset-a") : addTextLayer(p,"pose"); const id=p.layers[0].id;
    const a={x:.35,y:.3,scale:.8,rotation:-15,opacity:.7},b={x:.65,y:.6,scale:1.1,rotation:20,opacity:1};
    return updateLayer(p,id,{name:"pose",transform:a,keyframes:[{timeUs:0,transform:a},{timeUs:duration,transform:b}]});
  }
  it("keeps original frame5's pose exactly after removing frame0 instead of crossing a pixel floor", () => {
    const p=posedProject(30,true),original=transformAt(p.layers[0],frameBoundaryUs(5,30));
    const edited=deleteFrame(p,0,"ripple"),layer=edited.layers[0];
    expect(layer.keyframes).toHaveLength(2); expect(layer.transformSamples!.length).toBeGreaterThan(2);
    const actual=transformAt(layer,frameBoundaryUs(4,30)); expect(actual).toEqual(original);
    expect(Math.floor(actual.x*96)).toBe(Math.floor(original.x*96));
  });
  it("preserves text and media poses across every frame/clip cut, copy and hold at30/60fps", () => {
    for(const fps of [30,60]) for(const media of [false,true]) {
      const p=posedProject(fps,media),samples=Array.from({length:10},(_,n)=>transformAt(p.layers[0],frameBoundaryUs(n,fps)));
      const split=splitAtPlayhead(p,frameBoundaryUs(4,fps));
      const cases:[EditProject,number[]][]=[
        [deleteFrame(p,frameBoundaryUs(3,fps),"ripple"),[0,1,2,4,5,6,7,8,9]],
        [duplicateFrame(p,frameBoundaryUs(3,fps),"ripple"),[0,1,2,3,3,4,5,6,7,8,9]],
        [freezeFrame(p,frameBoundaryUs(3,fps),Math.round(3*1000000/fps),"ripple"),[0,1,2,3,3,3,4,5,6,7,8,9]],
        [duplicateClip(split,split.clips[0].id,"ripple"),[0,1,2,3,0,1,2,3,4,5,6,7,8,9]],
        [removeClip(split,split.clips[0].id,"ripple"),[4,5,6,7,8,9]],
      ];
      for(const [edited,indices] of cases) for(let frame=0;frame<indices.length;frame++) {
        const time=frameBoundaryUs(frame,fps),layer=activeLayer(edited,"pose",time);
        expect(transformAt(layer,time-layer.startUs)).toEqual(samples[indices[frame]]);
      }
      const held=activeLayer(cases[2][0],"pose",frameBoundaryUs(4,fps)); expect(held.transformSamples).toBeUndefined();
    }
  });
  it("resizes derived samples without replaying animation, then clears them on authored edits", () => {
    let p=deleteFrame(posedProject(30,true),0,"ripple"); const id=p.layers[0].id,original=p.layers[0];
    p=updateLayer(p,id,{startUs:10000,endUs:original.endUs+10000}); expect(p.layers[0].transformSamples).toBe(original.transformSamples);
    p=updateLayer(p,id,{endUs:110001}); const last=transformAt(original,100001);
    expect(p.layers[0].transformSamples!.slice(-1)[0]).toEqual({timeUs:100001,transform:last});
    p=updateLayer(p,id,{endUs:210000}); expect(transformAt(p.layers[0],150000)).toEqual(last);
    expect(parseProject(serializeProject(p)).layers).toEqual(p.layers);
    const renamed=updateLayer(p,id,{name:"renamed"}); expect(renamed.layers[0].transformSamples).toBe(p.layers[0].transformSamples);
    const moved=updateLayer(p,id,{transform:{...p.layers[0].transform,x:.8}}); expect(moved.layers[0].transformSamples).toBeUndefined();
    const keyed=upsertKeyframe(p,id,50000,{...DEFAULT_TRANSFORM,x:.2}); expect(keyed.layers[0].transformSamples).toBeUndefined();
    const recut=deleteFrame(p,0,"ripple"),layer=recut.layers[0];
    expect(transformAt(layer,0)).toEqual(transformAt(p.layers[0],33333-p.layers[0].startUs));
  });
  it("keeps sample scales in raster bounds and validates sample intervals and budgets", () => {
    let p=posedProject(30,true),id=p.layers[0].id,duration=projectDurationUs(p);
    const samples=[{timeUs:0,transform:{...DEFAULT_TRANSFORM,scale:4}},{timeUs:duration,transform:{...DEFAULT_TRANSFORM,scale:5}}];
    p=updateLayer(p,id,{transformSamples:samples});
    expect(duplicateClip(p,p.clips[0].id,"ripple").layers.every(layer=>(layer as ProjectMediaLayer).rasterScaleMax===5 || layer.id===id)).toBe(true);
    expect(()=>updateLayer(p,id,{transformSamples:[samples[0]]})).toThrow(/36002/);
    expect(()=>updateLayer(p,id,{transformSamples:[samples[0],{...samples[1],timeUs:duration-1}]})).toThrow(/whole layer/);
    expect(()=>updateLayer(p,id,{transformSamples:[samples[0],{...samples[1],timeUs:0}]})).toThrow(/strictly increasing/);
    expect(()=>updateLayer(p,id,{transformSamples:[samples[0],{...samples[1],transform:{...DEFAULT_TRANSFORM,opacity:2}}]})).toThrow();
    expect(()=>updateLayer(p,id,{transformSamples:Array.from({length:36003},(_,n)=>({timeUs:n,transform:DEFAULT_TRANSFORM}))})).toThrow(/36002/);
  });
});

describe("single output-frame editing", () => {
  it("isolates exactly one frame while preserving both neighboring intervals", () => {
    const p = fixture(); const result = isolateFrame(p, 50000);
    expect([result.startUs, result.endUs]).toEqual([33333, 66667]); expect(result.clipIds).toHaveLength(1);
    expect(result.project.clips.map(c => [c.inUs, c.outUs, clipDurationUs(c)])).toEqual([[0,33333,33333],[33333,66667,33334],[66667,1000000,933333]]);
    expect(projectDurationUs(result.project)).toBe(projectDurationUs(p)); expect(result.project.revision).toBe(p.revision + 1);
  });
  it("one output frame crossing a clip cut groups both source segments", () => {
    let p = splitClip(fixture(), "clip-a", 50_000); const second = p.clips[1].id; p = toggleClipReverse(p, second);
    const result = isolateFrame(p, 50000); expect(result.clipIds).toHaveLength(2);
    const deleted = deleteFrame(p, 50000); expect(projectDurationUs(deleted)).toBe(966667); expect(deleted.clips).toHaveLength(2);
    expect(deleted.clips[0].outUs).toBe(33333); expect(deleted.clips[1].reverse).toBe(true);
  });
  it("deletes or duplicates exactly one output frame with rational timing", () => {
    const p = fixture(1_000_003, .7, true), originalDuration = projectDurationUs(p);
    expect(projectDurationUs(deleteFrame(p, 33333))).toBe(originalDuration - 33333);
    expect(projectDurationUs(duplicateFrame(p, 33333))).toBe(originalDuration + 33334);
  });
  it("holds the current reversed source frame while retaining neighbors", () => {
    const p = fixture(1_000_000, 1, true); const next = freezeFrame(p, 33333, 500_000);
    expect(next.clips.map(clipDurationUs)).toEqual([33333, 500000, 933334]);
    const held = next.clips[1]; expect(held.inUs).toBe(966666); expect(held.outUs).toBe(held.inUs); expect(held.holdUs).toBe(500000);
    expect(sourceTimeAt(held, 123456)).toBe(held.inUs);
    expect(next.clips[0].outUs).toBe(1_000_000); expect(next.clips[2].inUs).toBe(0);
  });
  it("isolates a partial last frame and navigates only valid frame starts", () => {
    const p = fixture(101_000); expect(isolateFrame(p, 101000)).toMatchObject({ startUs: 100000, endUs: 101000 });
    expect(stepFrame(p, 100000, 1)).toBe(100000); expect(stepFrame(p, 0, -1)).toBe(0); expect(stepFrame(p, 66667, -1)).toBe(33333);
    expect(projectDurationUs(deleteFrame(p, 101000))).toBe(100000);
  });
  it("works for image holds and allows deleting the final remaining frame", () => {
    let p = createProject(); p = addAsset(p, { id: "image", path: "D:/image.png", name: "image", width: 480, height: 480, durationUs: 0, kind: "image" });
    p = addClip(p, "image", { holdUs: 50_000 }); expect(isolateFrame(p, 0).clipIds).toHaveLength(1);
    expect(deleteFrame(p, 0).clips).toHaveLength(0); expect(isolateFrame(createProject(), 0).clipIds).toEqual([]);
  });
  it("keeps repeated frame copies on the rational grid and reverses their removal", () => {
    for (const fps of [30, 60]) {
      let p = fixture(); p = updateProject(p, { canvas: { ...p.canvas, fps } });
      const original = p;
      for (let count = 1; count <= 120; count++) {
        p = duplicateFrame(p, 0);
        expect(projectDurationUs(p)).toBe(frameBoundaryUs(fps + count, fps));
        expect(frameIndexAt(projectDurationUs(p) - 1, fps) + 1).toBe(fps + count);
      }
      for (let count = 119; count >= 0; count--) {
        p = deleteFrame(p, frameBoundaryUs(1, fps));
        expect(projectDurationUs(p)).toBe(frameBoundaryUs(fps + count, fps));
      }
      expect(p.clips[0].inUs).toBe(0);
      expect(p.clips[p.clips.length - 1].outUs).toBe(original.clips[0].outUs);
      for (const entry of timelineEntries(p)) {
        for (const part of [0, .5, 1]) {
          const local = clipDurationUs(entry.clip) * part;
          expect(Math.abs(sourceTimeAt(entry.clip, local) - (entry.startUs + local))).toBeLessThanOrEqual(1);
        }
      }
    }
  });
  it("snaps frame-specific holds to complete output frames without touching source ranges", () => {
    const p = fixture(); const held = freezeFrame(p, 33333, 50000);
    expect(held.clips[1].holdUs).toBe(66667);
    expect(projectDurationUs(held)).toBe(frameBoundaryUs(31, 30));
    expect(held.clips[2].inUs).toBe(66667); expect(held.clips[2].outUs).toBe(1000000);
    expect(freezeFrame(p, 33333, 33334).clips[1].holdUs).toBe(33334);
  });
  it("duplicates even a tiny partial final frame into an additional output sample", () => {
    let p = fixture(100001);
    for (let count = 1; count <= 30; count++) {
      p = duplicateFrame(p, projectDurationUs(p) - 1);
      expect(frameIndexAt(projectDurationUs(p) - 1, p.canvas.fps) + 1).toBe(4 + count);
      expect(projectDurationUs(p)).toBe(frameBoundaryUs(3 + count, p.canvas.fps) + 1);
    }
    const partial = addTextLayer(fixture(101000), "tail", 100000, 200000);
    expect(deleteFrame(partial, 100999, "ripple").layers[0]).toMatchObject({ startUs: 100000, endUs: 199000 });
  });
});

describe("layers, timing and keyframes", () => {
  it("creates single-frame captions and overlays", () => {
    let p = addTextLayer(fixture(), "这一帧", 33333, 66667); p = addMediaLayer(p, "asset-a", 33333, 66667);
    expect(p.layers.map(l => l.endUs - l.startUs)).toEqual([33334,33334]); assertProject(p);
  });
  it("preserves absolute layer times by default and offers explicit ripple", () => {
    let p = addTextLayer(fixture(), "字幕", 100000, 900000); const layer = p.layers[0];
    p = upsertKeyframe(p, layer.id, 0, { ...DEFAULT_TRANSFORM, x: .1 });
    p = upsertKeyframe(p, layer.id, 800000, { ...DEFAULT_TRANSFORM, x: .9 });
    expect(deleteFrame(p, 0).layers).toEqual(p.layers);
    const ripple = deleteFrame(p, 0, "ripple"); expect(ripple.layers[0]).toMatchObject({ startUs: 66667, endUs: 866667 });
    expect(ripple.layers[0].keyframes).toEqual(p.layers[0].keyframes);
    const extended = freezeFrame(p, 333333, 1_000_000, "ripple");
    expect(extended.layers.map(l => [l.startUs, l.endUs])).toEqual([[100000,333333],[333333,1333333],[1333333,1866667]]);
  });
  it("removes a layer entirely when its interval is ripple-deleted", () => {
    const p = addTextLayer(fixture(), "one", 33333, 66667); expect(deleteFrame(p, 33333, "ripple").layers).toEqual([]);
  });
  it("upserts sorted unique keyframes, interpolates and prunes after trim", () => {
    let p = addTextLayer(fixture()); const id = p.layers[0].id;
    p = upsertKeyframe(p, id, 1000000, { ...DEFAULT_TRANSFORM, x: 1, opacity: 0 });
    p = upsertKeyframe(p, id, 0, { ...DEFAULT_TRANSFORM, x: 0 });
    p = upsertKeyframe(p, id, 0, { ...DEFAULT_TRANSFORM, x: .2 });
    expect(p.layers[0].keyframes).toHaveLength(2); expect(transformAt(p.layers[0], 500000).x).toBeCloseTo(.6); expect(transformAt(p.layers[0], 500000).opacity).toBe(.5);
    p = updateLayer(p, id, { endUs: 500000 }); expect(p.layers[0].keyframes).toHaveLength(1);
    p = removeKeyframe(p, id, 0); expect(transformAt(p.layers[0], 100)).toEqual(DEFAULT_TRANSFORM);
  });
});

function threeClips() {
  let p = fixture(3_000_000);
  p = splitAtPlayhead(p, 1_000_000); p = splitAtPlayhead(p, 2_000_000);
  return p;
}
function animatedLayer(project: EditProject, name: string, startUs = 0, endUs = projectDurationUs(project), media = false): EditProject {
  let p = media ? addMediaLayer(project, "asset-a", startUs, endUs) : addTextLayer(project, name, startUs, endUs);
  const id = p.layers[p.layers.length - 1].id;
  p = updateLayer(p, id, { name });
  p = upsertKeyframe(p, id, 0, { ...DEFAULT_TRANSFORM, x: 0 });
  return upsertKeyframe(p, id, endUs - startUs, { ...DEFAULT_TRANSFORM, x: 1 });
}
function activeLayer(project: EditProject, name: string, timeUs: number): ProjectLayer {
  const matches = project.layers.filter(l => l.name === name && l.startUs <= timeUs && timeUs < l.endUs);
  expect(matches).toHaveLength(1); return matches[0];
}

describe("ripple layer pieces and source clocks", () => {
  it("cuts a middle interval without interpolating across the removed animation", () => {
    let p = animatedLayer(threeClips(), "moving"); p = animatedLayer(p, "media", 0, 3_000_000, true);
    const source = p.layers[1] as ProjectMediaLayer; p = updateLayer(p, source.id, { sourceOffsetUs: 250000 });
    const before = JSON.stringify(p); const edited = removeClip(p, p.clips[1].id, "ripple");
    expect(JSON.stringify(p)).toBe(before); expect(projectDurationUs(edited)).toBe(2_000_000);
    for (const name of ["moving", "media"]) {
      expect(edited.layers.filter(l => l.name === name).map(l => [l.startUs,l.endUs])).toEqual([[0,1000000],[1000000,2000000]]);
      const left = activeLayer(edited,name,999999), right = activeLayer(edited,name,1000000);
      expect(transformAt(left,999999).x).toBeCloseTo(999999/3000000, 10);
      expect(transformAt(right,0).x).toBeCloseTo(2/3, 10);
      expect(transformAt(right,500000).x).toBeCloseTo(5/6, 10);
    }
    const rightMedia = activeLayer(edited,"media",1500000) as ProjectMediaLayer;
    expect(rightMedia.sourceOffsetUs).toBe(2250000); expect(mediaSourceTimeAt(rightMedia,500000)).toBe(2750000);
  });
  it("uses half-open deletion boundaries and preserves right-hand starting values", () => {
    let p = threeClips();
    p = addTextLayer(p,"ends at cut",0,1000000); p = addTextLayer(p,"inside",1000000,2000000); p = animatedLayer(p,"after",2000000,3000000);
    const before = p.layers[0], after = p.layers[2]; const edited = removeClip(p,p.clips[1].id,"ripple");
    expect(edited.layers[0]).toBe(before); expect(edited.layers.some(l=>l.name==="inside")).toBe(false);
    expect(edited.layers[1]).toMatchObject({id:after.id,startUs:1000000,endUs:2000000,keyframes:after.keyframes});
    const full = animatedLayer(threeClips(),"head cut",0,3000000,true);
    const head = removeClip(full,full.clips[0].id,"ripple").layers[0] as ProjectMediaLayer;
    expect(head.startUs).toBe(0); expect(head.sourceOffsetUs).toBe(1000000); expect(transformAt(head,0).x).toBeCloseTo(1/3);
  });
  it("copies exactly the selected clip's text, keyframe segment and animated source phase", () => {
    let p = animatedLayer(threeClips(),"motion",0,3000000,true); p = addTextLayer(p,"caption",1200000,1800000);
    p = addTextLayer(p,"following",2000000,2500000);
    const edited = duplicateClip(p,p.clips[1].id,"ripple");
    expect(edited.layers.filter(l=>l.name==="caption").map(l=>[l.startUs,l.endUs])).toEqual([[1200000,1800000],[2200000,2800000]]);
    expect(edited.layers.find(l=>l.name==="following")).toMatchObject({startUs:3000000,endUs:3500000});
    const copy = activeLayer(edited,"motion",2500000) as ProjectMediaLayer;
    const tail = activeLayer(edited,"motion",3500000) as ProjectMediaLayer;
    expect(copy.sourceOffsetUs).toBe(1000000); expect(mediaSourceTimeAt(copy,500000)).toBe(1500000);
    expect(transformAt(copy,500000).x).toBeCloseTo(.5); expect(mediaSourceTimeAt(tail,500000)).toBe(2500000);
    expect(transformAt(tail,500000).x).toBeCloseTo(5/6);
  });
  it("retains a single-frame caption on its copy and excludes adjacent captions", () => {
    let p = fixture(); p = addTextLayer(p,"before",0,33333); p = addTextLayer(p,"selected",33333,66667); p = addTextLayer(p,"next",66667,100000);
    const edited = duplicateFrame(p,33333,"ripple");
    expect(edited.layers.filter(l=>l.name==="selected").map(l=>[l.startUs,l.endUs])).toEqual([[33333,66667],[66667,100000]]);
    expect(edited.layers.filter(l=>l.name==="before")).toHaveLength(1);
    expect(edited.layers.filter(l=>l.name==="next")).toHaveLength(1);
    expect(edited.layers.find(l=>l.name==="next")).toMatchObject({startUs:100000,endUs:133333});
    expect(activeLayer(edited,"selected",66667)).toMatchObject({kind:"text",text:"selected"});
  });
  it("freezes the composed frame and resumes animation after it without stretching", () => {
    let p = animatedLayer(fixture(),"sticker",0,1000000,true); p = addTextLayer(p,"frame text",333333,366667);
    const original = p.layers[0]; const edited = freezeFrame(p,333333,1000000,"ripple");
    const before = activeLayer(edited,"sticker",200000);
    const held = activeLayer(edited,"sticker",700000) as ProjectMediaLayer;
    const after = activeLayer(edited,"sticker",1433333) as ProjectMediaLayer;
    expect(transformAt(before,200000).x).toBeCloseTo(transformAt(original,200000).x);
    expect(held).toMatchObject({startUs:333333,endUs:1333333,sourceFrozen:true,sourceOffsetUs:333333,keyframes:[]});
    expect(transformAt(held,0).x).toBe(transformAt(held,999999).x); expect(mediaSourceTimeAt(held,999999)).toBe(333333);
    expect(after.sourceOffsetUs).toBe(366667); expect(mediaSourceTimeAt(after,100000)).toBe(466667);
    expect(transformAt(after,0).x).toBeCloseTo(.366667); expect(transformAt(after,100000).x).toBeCloseTo(.466667,5);
    expect(edited.layers.find(l=>l.name==="frame text")).toMatchObject({startUs:333333,endUs:1333333,keyframes:[]});
  });
  it("honors already frozen source clocks when slicing or duplicating", () => {
    let p = animatedLayer(threeClips(),"frozen",0,3000000,true);
    p = updateLayer(p,p.layers[0].id,{sourceOffsetUs:7654321,sourceFrozen:true});
    const deleted = removeClip(p,p.clips[1].id,"ripple");
    expect(deleted.layers.every(l=>l.kind==="media" && mediaSourceTimeAt(l,100000)===7654321)).toBe(true);
    const copied = duplicateClip(p,p.clips[1].id,"ripple");
    expect(copied.layers.every(l=>l.kind==="media" && mediaSourceTimeAt(l,100000)===7654321)).toBe(true);
  });
  it("protects every locked layer from all ripple changes and copied material", () => {
    let p = animatedLayer(threeClips(),"locked",0,3000000,true); p = updateLayer(p,p.layers[0].id,{locked:true,sourceOffsetUs:123});
    const original = p.layers[0];
    const edits = [removeClip(p,p.clips[1].id,"ripple"),deleteFrame(p,33333,"ripple"),duplicateFrame(p,33333,"ripple"),freezeFrame(p,33333,500000,"ripple"),duplicateClip(p,p.clips[1].id,"ripple"),setClipRate(p,p.clips[1].id,2,"ripple")];
    for (const edited of edits) { expect(edited.layers).toHaveLength(1); expect(edited.layers[0]).toBe(original); }
  });
  it("keeps media phase and transform stable over repeated 30/60 fps copy-delete pairs", () => {
    for (const fps of [30,60]) {
      let p = updateProject(fixture(),{canvas:{...fixture().canvas,fps}}); p = animatedLayer(p,"loop",0,1000000,true);
      const first = frameBoundaryUs(1,fps), second = frameBoundaryUs(2,fps);
      p = addTextLayer(p,"one frame",first,second);
      for (let i=0;i<50;i++) {
        p = duplicateFrame(p,first,"ripple");
        expect(projectDurationUs(p)).toBe(frameBoundaryUs(fps+1,fps));
        expect(activeLayer(p,"one frame",second).kind).toBe("text");
        p = deleteFrame(p,second,"ripple"); expect(projectDurationUs(p)).toBe(1000000);
        const layer = activeLayer(p,"loop",500000) as ProjectMediaLayer;
        expect(mediaSourceTimeAt(layer,500000-layer.startUs)).toBe(500000);
        expect(transformAt(layer,500000-layer.startUs).x).toBeCloseTo(.5,10);
      }
      expect(p.layers.filter(l=>l.name==="one frame")).toHaveLength(1);
      expect(p.layers.filter(l=>l.name==="one frame")[0]).toMatchObject({startUs:first,endUs:second});
    }
  });
});

describe("ripple duration commands and transactional limits", () => {
  it("uses one tail-splice policy for properties, trim, rate and whole-clip hold", () => {
    const p = animatedLayer(threeClips(),"following",1000000,2000000,true), id=p.clips[0].id;
    const cases: [EditProject,number][] = [
      [updateClip(p,id,{holdUs:2000000},"ripple"),2000000],
      [trimClip(p,id,100000,600000,"ripple"),500000],
      [setClipRate(p,id,2,"ripple"),500000],
      [freezeClip(p,id,500000,2000000,"ripple"),2000000],
    ];
    for (const [edited,startUs] of cases) {
      const layer=edited.layers[0] as ProjectMediaLayer;
      expect(layer).toMatchObject({startUs,endUs:startUs+1000000,keyframes:p.layers[0].keyframes});
      expect(mediaSourceTimeAt(layer,500000)).toBe(500000);
    }
  });
  it("holds the preceding layer at a tail extension and resumes the following animation", () => {
    let p = animatedLayer(threeClips(),"through",0,3000000,true); p = addTextLayer(p,"ends here",0,1000000); p = addTextLayer(p,"starts here",1000000,1500000);
    const edited=setClipRate(p,p.clips[0].id,.5,"ripple");
    const held=activeLayer(edited,"through",1500000) as ProjectMediaLayer;
    expect(held).toMatchObject({startUs:1000000,endUs:2000000,sourceOffsetUs:999999,sourceFrozen:true,keyframes:[]});
    expect(edited.layers.filter(l=>l.name==="ends here").map(l=>[l.startUs,l.endUs])).toEqual([[0,1000000],[1000000,2000000]]);
    expect(edited.layers.find(l=>l.name==="starts here")).toMatchObject({startUs:2000000,endUs:2500000});
    const tail=activeLayer(edited,"through",2500000) as ProjectMediaLayer;
    expect(tail.sourceOffsetUs).toBe(1000000); expect(transformAt(tail,500000).x).toBeCloseTo(.5);
  });
  it("leaves layers untouched for absolute calls and equal-duration changes", () => {
    const p=animatedLayer(threeClips(),"motion"),id=p.clips[0].id;
    expect(p.editing?.layerTiming).toBe("ripple");
    for(const edited of [duplicateClip(p,id),setClipRate(p,id,2),trimClip(p,id,100000,600000),freezeClip(p,id,0,2000000),updateClip(p,id,{reverse:true},"ripple"),trimClip(p,id,500000,1500000,"ripple")]) expect(edited.layers).toBe(p.layers);
    const split=splitClip(fixture(1000003,.7),"clip-a",33333);
    expect(trimClip(split,"clip-a",split.clips[0].inUs,split.clips[0].outUs,"ripple")).toBe(split);
  });
  it("fails atomically instead of dropping excess split layers or keyframes", () => {
    let p=fixture(); for(let i=0;i<64;i++) p=addTextLayer(p,`layer ${i}`);
    const before=JSON.stringify(p); expect(()=>duplicateClip(p,p.clips[0].id,"ripple")).toThrow(/64/); expect(JSON.stringify(p)).toBe(before);
    let keyed=splitClip(fixture(),"clip-a",500); keyed=addTextLayer(keyed,"key limit"); const id=keyed.layers[0].id;
    for(let i=0;i<128;i++) keyed=upsertKeyframe(keyed,id,1000+i*7000,{...DEFAULT_TRANSFORM,x:i/128});
    const old=JSON.stringify(keyed); expect(()=>removeClip(keyed,"clip-a","ripple")).toThrow(/128/); expect(JSON.stringify(keyed)).toBe(old);
  });
  it("commits a ripple cut and all layer fragments as a single undoable operation", () => {
    const p=animatedLayer(threeClips(),"motion",0,3000000,true); const edited=removeClip(p,p.clips[1].id,"ripple");
    const history=commitHistory(createHistory(p),edited); expect(history.past).toHaveLength(1); expect(history.present.revision).toBe(p.revision+1);
    expect(undoHistory(history).present.layers).toEqual(p.layers); expect(redoHistory(undoHistory(history)).present.layers).toEqual(edited.layers);
  });
  it("validates the optional editing and source-clock contract while accepting old data", () => {
    let p=addMediaLayer(fixture(),"asset-a"); const id=p.layers[0].id;
    expect(()=>assertProject({...p,editing:undefined})).not.toThrow();
    expect(()=>updateProject(p,{editing:{layerTiming:"bad" as "ripple"}})).toThrow();
    expect(()=>updateLayer(p,id,{sourceOffsetUs:-1})).toThrow(); expect(()=>updateLayer(p,id,{sourceOffsetUs:86400000001})).toThrow();
    expect(()=>updateLayer(p,id,{sourceFrozen:1 as unknown as boolean})).toThrow();
    p=updateLayer(p,id,{sourceOffsetUs:86400000000});
    expect(()=>deleteFrame(p,0,"ripple")).toThrow(/sourceOffsetUs|sourceTimeMap/);
    expect(()=>duplicateFrame(p,0,"bad" as "ripple")).toThrow();
  });
});

describe("exact source phase across rounded frame grids", () => {
  it("keeps a source boundary at 100000µs after deleting a 30 fps frame", () => {
    let p=addMediaLayer(fixture(),"asset-a"); p=updateLayer(p,p.layers[0].id,{name:"phase",sourceOffsetUs:33333});
    const edited=deleteFrame(p,0,"ripple"), layer=edited.layers[0] as ProjectMediaLayer;
    expect(layer.sourceOffsetUs).toBe(66666);
    expect(mediaSourceTimeAt(layer,33333)).toBe(100000);
    expect(layer.sourceTimeMap?.some(point=>point.timeUs===33333 && point.sourceUs===100000)).toBe(true);
    for(let frame=0;frame<29;frame++) expect(mediaSourceTimeAt(layer,frameBoundaryUs(frame,30))).toBe(33333+frameBoundaryUs(frame+1,30));
  });
  it("preserves every retained/copied/held source sample at 30 and 60 fps", () => {
    for(const fps of [30,60]) {
      let p=fixture(); p=updateProject(p,{canvas:{...p.canvas,fps}}); p=addMediaLayer(p,"asset-a");
      p=updateLayer(p,p.layers[0].id,{name:"phase",sourceOffsetUs:33333.5});
      const sourceTimes=Array.from({length:fps},(_,n)=>33333.5+frameBoundaryUs(n,fps));
      const index=1, at=frameBoundaryUs(index,fps);
      const cases: [EditProject,number[]][]=[
        [deleteFrame(p,at,"ripple"),sourceTimes.filter((_,n)=>n!==index)],
        [duplicateFrame(p,at,"ripple"),[...sourceTimes.slice(0,2),sourceTimes[1],...sourceTimes.slice(2)]],
        [freezeFrame(p,at,Math.round(3*1000000/fps),"ripple"),[sourceTimes[0],sourceTimes[1],sourceTimes[1],sourceTimes[1],...sourceTimes.slice(2)]],
      ];
      for(const [edited,expected] of cases) for(let frame=0;frame<expected.length;frame++) {
        const time=frameBoundaryUs(frame,fps),layer=activeLayer(edited,"phase",time) as ProjectMediaLayer;
        expect(mediaSourceTimeAt(layer,time-layer.startUs)).toBe(expected[frame]);
      }
    }
  });
  it("composes a frame cut, ordinary tail trim and another frame cut without phase rounding", () => {
    let p=fixture(2000000); p=splitAtPlayhead(p,1000000); p=addMediaLayer(p,"asset-a",1000000,2000000);
    p=updateLayer(p,p.layers[0].id,{name:"phase",sourceOffsetUs:33333.125});
    p=deleteFrame(p,0,"ripple");
    p=trimClip(p,p.clips[0].id,p.clips[0].inUs,p.clips[0].outUs-123,"ripple");
    const previous=p,edited=deleteFrame(p,frameBoundaryUs(5,30),"ripple");
    for(let frame=30;frame<57;frame++) {
      const time=frameBoundaryUs(frame,30),oldTime=frameBoundaryUs(frame+1,30);
      const layer=activeLayer(edited,"phase",time) as ProjectMediaLayer,old=activeLayer(previous,"phase",oldTime) as ProjectMediaLayer;
      expect(mediaSourceTimeAt(layer,time-layer.startUs)).toBe(mediaSourceTimeAt(old,oldTime-old.startUs));
    }
    const time=1200000,old=activeLayer(edited,"phase",time) as ProjectMediaLayer,source=mediaSourceTimeAt(old,time-old.startUs);
    const frozen=freezeFrame(edited,time,100000,"ripple"),held=activeLayer(frozen,"phase",time) as ProjectMediaLayer;
    expect(held.sourceOffsetUs).toBe(source); expect(held.sourceFrozen).toBe(true); expect(held.sourceTimeMap).toBeUndefined();
  });
  it("keeps the original raster bound on trimmed, duplicated and frozen media pieces", () => {
    let p=animatedLayer(threeClips(),"raster",0,3000000,true);
    p=upsertKeyframe(p,p.layers[0].id,3000000,{...DEFAULT_TRANSFORM,scale:3});
    for(const edited of [removeClip(p,p.clips[1].id,"ripple"),duplicateClip(p,p.clips[1].id,"ripple"),freezeFrame(p,333333,1000000,"ripple")]) {
      for(const layer of edited.layers) expect((layer as ProjectMediaLayer).rasterScaleMax).toBe(3);
    }
    p=updateLayer(p,p.layers[0].id,{rasterScaleMax:5});
    expect(freezeFrame(p,333333,1000000,"ripple").layers.every(layer=>(layer as ProjectMediaLayer).rasterScaleMax===5)).toBe(true);
  });
  it("validates exact clocks, fractional source times and frozen-map exclusivity", () => {
    let p=addMediaLayer(fixture(),"asset-a"),id=p.layers[0].id;
    const map=[{timeUs:0,sourceUs:.125},{timeUs:500000,sourceUs:500000.25},{timeUs:1000000,sourceUs:1000000.5}];
    p=updateLayer(p,id,{sourceOffsetUs:.5,sourceTimeMap:map,rasterScaleMax:2});
    expect(mediaSourceTimeAt(p.layers[0] as ProjectMediaLayer,250000)).toBe(250000.1875);
    expect(()=>updateLayer(p,id,{sourceFrozen:true})).toThrow(/Frozen/);
    expect(()=>updateLayer(p,id,{rasterScaleMax:9})).toThrow();
    expect(()=>updateLayer(p,id,{sourceTimeMap:[{timeUs:0,sourceUs:0},{timeUs:999999,sourceUs:1000000}]})).toThrow(/whole layer/);
    expect(()=>updateLayer(p,id,{sourceTimeMap:[{timeUs:0,sourceUs:0},{timeUs:1000000,sourceUs:0}]})).toThrow(/strictly increase/);
    expect(()=>updateLayer(p,id,{sourceTimeMap:[{timeUs:0,sourceUs:0},{timeUs:1000000,sourceUs:NaN}]})).toThrow();
    expect(()=>updateLayer(p,id,{sourceTimeMap:Array.from({length:36003},(_,n)=>({timeUs:n,sourceUs:n}))})).toThrow(/36002/);
  });
  it("keeps existing source maps editable through move, trim, extension, save and another cut", () => {
    let p=addMediaLayer(fixture(2000000),"asset-a",100000,1100000),id=p.layers[0].id;
    const map=[{timeUs:0,sourceUs:.25},{timeUs:33333,sourceUs:33333.25},{timeUs:66667,sourceUs:66666.25},{timeUs:1000000,sourceUs:1000000.25}];
    p=updateLayer(p,id,{name:"editable clock",sourceTimeMap:map}); const original=p.layers[0] as ProjectMediaLayer;
    p=updateLayer(p,id,{startUs:200000,endUs:1200000}); expect((p.layers[0] as ProjectMediaLayer).sourceTimeMap).toBe(map);
    p=updateLayer(p,id,{endUs:750000});
    expect((p.layers[0] as ProjectMediaLayer).sourceTimeMap?.slice(-1)[0]).toEqual({timeUs:550000,sourceUs:mediaSourceTimeAt(original,550000)});
    p=updateLayer(p,id,{endUs:950000}); const extended=p.layers[0] as ProjectMediaLayer;
    expect(extended.sourceTimeMap?.slice(-1)[0].timeUs).toBe(750000);
    expect(mediaSourceTimeAt(extended,750000)).toBeCloseTo(mediaSourceTimeAt(original,750000),7);
    const restored=parseProject(serializeProject(p)); expect(restored.layers).toEqual(p.layers);
    const edited=deleteFrame(restored,0,"ripple");
    for(let n=7;n<27;n++) {
      const time=frameBoundaryUs(n,30),previousTime=frameBoundaryUs(n+1,30);
      const layer=activeLayer(edited,"editable clock",time) as ProjectMediaLayer;
      expect(mediaSourceTimeAt(layer,time-layer.startUs)).toBe(mediaSourceTimeAt(extended,previousTime-extended.startUs));
    }
    expect(()=>updateLayer(p,id,{endUs:300000001})).toThrow(); expect(p.layers[0]).toBe(extended);
  });
  it("does not lose an integral source sample on a long collinear span", () => {
    const p=addMediaLayer(fixture(299900000),"asset-a",0,299866667);
    const layer={...p.layers[0],kind:"media" as const,assetId:"asset-a",width:.3,sourceTimeMap:[{timeUs:0,sourceUs:33333},{timeUs:299866667,sourceUs:299900000}]} as ProjectMediaLayer;
    expect(mediaSourceTimeAt(layer,30066667)).toBe(30100000);
  });
  it("rejects colliding source-clock knots instead of silently dropping a different sample", () => {
    let p=addMediaLayer(fixture(),"asset-a");
    p=updateLayer(p,p.layers[0].id,{sourceTimeMap:[{timeUs:0,sourceUs:0},{timeUs:50000,sourceUs:50000},{timeUs:50001,sourceUs:50002},{timeUs:1000000,sourceUs:1000001}]});
    const before=JSON.stringify(p); expect(()=>deleteFrame(p,0,"ripple")).toThrow(/collide/); expect(JSON.stringify(p)).toBe(before);
  });
  it("rejects a large copied project atomically at the real 8 MiB limit", () => {
    let p=addMediaLayer(fixture(),"asset-a"); const base=p.layers[0] as ProjectMediaLayer;
    const points=Array.from({length:36002},(_,index)=>{ const timeUs=Math.round(index*1000000/36001); return {timeUs,sourceUs:timeUs+(index%2?.123456789:.987654321)}; });
    p={...p,layers:[]};
    do { p={...p,layers:[...p.layers,{...base,id:`large-${p.layers.length}`,sourceTimeMap:points}]}; } while(new TextEncoder().encode(JSON.stringify(p)).length<=PROJECT_LIMITS.jsonBytes/2);
    assertProject(p); const before=JSON.stringify(p);
    expect(()=>duplicateClip(p,p.clips[0].id,"ripple")).toThrow(/8 MiB/); expect(JSON.stringify(p)).toBe(before);
  });
  it("checks the finalized revision when its extra digit crosses the project byte budget", () => {
    const p={...fixture(),name:"a",revision:9}; const originalLimit=PROJECT_LIMITS.jsonBytes;
    Reflect.set(PROJECT_LIMITS,"jsonBytes",new TextEncoder().encode(JSON.stringify(p)).length);
    try { expect(()=>updateProject(p,{name:"b"})).toThrow(/8 MiB/); expect(p.revision).toBe(9); }
    finally { Reflect.set(PROJECT_LIMITS,"jsonBytes",originalLimit); }
  });
});

describe("atomic history and validation", () => {
  it("undoes an entire isolation once, suppresses noops, clears redo on a new edit", () => {
    const p = fixture(); let h = createHistory(p, 2);
    expect(commitHistory(h, updateProject(p, { name: p.name }))).toBe(h);
    h = commitHistory(h, isolateFrame(p, 50000).project, "单帧隔离"); expect(h.past).toHaveLength(1);
    const splitRevision = h.present.revision; h = undoHistory(h); expect(h.present.clips).toEqual(p.clips); expect(h.present.revision).toBeGreaterThan(splitRevision);
    h = redoHistory(h); expect(h.present.clips).toHaveLength(3);
    h = undoHistory(h); h = commitHistory(h, updateProject(h.present, { name: "new" })); expect(h.future).toEqual([]);
    h = commitHistory(h, duplicateClip(h.present, "clip-a")); h = commitHistory(h, removeClip(h.present, "clip-a")); expect(h.past).toHaveLength(2);
  });
  it("rejects bad sources, crop, rate, transform and dangling asset references", () => {
    const p = fixture();
    expect(() => updateClip(p, "clip-a", { rate: NaN })).toThrow(); expect(() => updateClip(p, "clip-a", { rate: 0 })).toThrow();
    expect(() => updateClip(p, "clip-a", { outUs: 1_000_001 })).toThrow();
    expect(() => updateClip(p, "clip-a", { crop: { left: .6, right: .4, top: 0, bottom: 0 } })).toThrow();
    expect(() => relinkAsset(p, "asset-a", { durationUs: 1 })).toThrow();
    const layered = addTextLayer(p); expect(() => updateLayer(layered, layered.layers[0].id, { transform: { ...DEFAULT_TRANSFORM, opacity: Infinity } })).toThrow();
    expect(() => addMediaLayer(p, "missing")).toThrow();
  });
  it("rejects values the desktop renderer cannot save or render", () => {
    const p = fixture();
    expect(() => updateProject(p, { canvas: { ...p.canvas, fps: 29.97 } })).toThrow();
    expect(() => updateProject(p, { canvas: { ...p.canvas, background: "transparent" } })).toThrow();
    expect(() => updateProject(p, { output: { ...p.output, maxBytes: 100 } })).toThrow();
    expect(() => updateClip(p, "clip-a", { holdUs: 300_000_001 })).toThrow();
    expect(() => updateClip(p, "clip-a", { rate: .04 })).toThrow();
    const layered = addTextLayer(p);
    expect(() => updateLayer(layered, layered.layers[0].id, { transform: { ...DEFAULT_TRANSFORM, scale: 9 } })).toThrow();
    expect(() => updateLayer(layered, layered.layers[0].id, { fontSize: 513 })).toThrow();
  });
});
