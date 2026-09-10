/** Generate the JS-to-Rust editing contract fixture using production model operations.
 * Bundle with esbuild for Node and run from the repository root.
 * Expected frames are independently specified examples, not calculated from the model.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  addAsset, addClip, addMediaLayer, addTextLayer, createProject, deleteFrame,
  duplicateClip, duplicateFrame, frameBoundaryUs, freezeFrame, removeClip, splitAtPlayhead,
  updateLayer, updateProject, upsertKeyframe,
} from "../src/v6/editor/model";
import type { EditProject } from "../src/v6/editor/types";

function makeProject(fps: number) {
  const boundary = (frame: number) => frameBoundaryUs(frame, fps);
  let project = createProject("Ripple contract");
  project = updateProject(project, { canvas: { width: 96, height: 64, fps, background: "#FFFFFF" }, output: { loop: true, maxBytes: null, smartLossless: false } });
  project = addAsset(project, { id: "source", path: "source.mkv", name: "Source", kind: "video", width: 96, height: 64, durationUs: boundary(10) });
  project = addClip(project, "source");
  project = addMediaLayer(project, "source", 0, boundary(10));
  project = updateLayer(project, project.layers[0].id, { width: .35, transform: { x: .35, y: .3, scale: .8, rotation: -15, opacity: 1 } });
  project = upsertKeyframe(project, project.layers[0].id, 0, { ...project.layers[0].transform });
  project = upsertKeyframe(project, project.layers[0].id, boundary(10), { ...project.layers[0].transform, x: .65, scale: 1.1, rotation: 20 });
  project = addTextLayer(project, "Frame", boundary(2), boundary(5));
  project = updateLayer(project, project.layers[1].id, { fontSize: 10, strokeWidth: 0, transform: { x: .3, y: .8, scale: 1, rotation: 0, opacity: 1 } });
  project = upsertKeyframe(project, project.layers[1].id, 0, { ...project.layers[1].transform });
  return upsertKeyframe(project, project.layers[1].id, boundary(5) - boundary(2), { ...project.layers[1].transform, x: .7 });
}
function stable(value: EditProject): EditProject {
  return { ...value, id: "ripple-contract", revision: 1,
    clips: value.clips.map((clip, index) => ({ ...clip, id: `clip-${index}` })),
    layers: value.layers.map((layer, index) => ({ ...layer, id: `layer-${index}` })),
  };
}
const suites = [25, 30, 60].map(fps => {
  const project = makeProject(fps), boundary = (frame: number) => frameBoundaryUs(frame, fps);
  const split = splitAtPlayhead(project, boundary(4));
  return { fps, baseline: stable(project), cases: [
    { name: "delete-frame-0", project: stable(deleteFrame(project, 0, "ripple")), expectedFrames: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    { name: "delete-frame-3", project: stable(deleteFrame(project, boundary(3), "ripple")), expectedFrames: [0, 1, 2, 4, 5, 6, 7, 8, 9] },
    { name: "duplicate-frame-3", project: stable(duplicateFrame(project, boundary(3), "ripple")), expectedFrames: [0, 1, 2, 3, 3, 4, 5, 6, 7, 8, 9] },
    { name: "hold-frame-3-for-three", project: stable(freezeFrame(project, boundary(3), boundary(3), "ripple")), expectedFrames: [0, 1, 2, 3, 3, 3, 4, 5, 6, 7, 8, 9] },
    { name: "duplicate-first-clip", project: stable(duplicateClip(split, split.clips[0].id, "ripple")), expectedFrames: [0, 1, 2, 3, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
    { name: "delete-first-clip", project: stable(removeClip(split, split.clips[0].id, "ripple")), expectedFrames: [4, 5, 6, 7, 8, 9] },
  ] };
});
const fixtures = {
  schemaVersion: 1,
  description: "Production TypeScript model projects; expected composite samples at 25, 30 and 60 fps.",
  suites,
};
mkdirSync("test/fixtures", { recursive: true });
writeFileSync("test/fixtures/project-ripple.json", JSON.stringify(fixtures, null, 2) + "\n");
console.log(`Wrote ${suites.length * suites[0].cases.length} cross-language ripple cases.`);
