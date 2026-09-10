import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import type { EditProject, ProjectRenderRequest, ProjectRenderResult } from "./types";

export interface SavedEditProject { path: string; project: EditProject }
export const hasProjectNative = () => isTauri();
export const projectMediaUrl = (path: string) => /^https?:|^blob:|^data:|^\/preset-previews\//.test(path) ? path : convertFileSrc(path);
export const renderEditProject = (request: ProjectRenderRequest) => invoke<ProjectRenderResult>("render_edit_project", { request });
export const saveEditProject = (project: EditProject, path?: string) => invoke<SavedEditProject | null>("save_edit_project", { project, path: path ?? null });
export const openEditProject = () => invoke<SavedEditProject | null>("open_edit_project");
