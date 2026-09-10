import { useState } from "react";
import GifpV3 from "./v3/GifpV3";
import ProjectStudio from "./v6/editor/ProjectStudio";

export default function App() {
  const [workspace, setWorkspace] = useState<"studio" | "tools">("studio");
  return workspace === "studio"
    ? <ProjectStudio onClose={() => setWorkspace("tools")} />
    : <GifpV3 onOpenStudio={() => setWorkspace("studio")} />;
}
