from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "strategy" / "2026-08-31-gifp-2m-product-study-artifact.json"
FRONTIER_PATH = ROOT / "tmp" / "quality-lab" / "2m-frontier-objective.json"
PHASE1_PATH = ROOT / "tmp" / "quality-lab" / "runs" / "3c117b7630f9-1788149059892-13372-2" / "report-bundle" / "report.json"
NOTEBOOK_PATH = ROOT / "docs" / "strategy" / "2026-08-31-gifp-2m-product-study.ipynb"
ARENA_PATH = ROOT / "docs" / "benchmarks" / "2026-08-08-gifp-5.7.25-arena10.md"
GENERATED_AT = "2026-08-31T14:10:00+08:00"


frontier_raw = json.loads(FRONTIER_PATH.read_text(encoding="utf-8"))
phase1_raw = json.loads(PHASE1_PATH.read_text(encoding="utf-8"))
rows_by_profile = {row["profile"]: row for row in frontier_raw["rows"]}
profile_order = ["cap-5", "cap-8", "cap-10", "cap-12", "cap-15", "cap-20", "cap-24", "cap-30-fast", "fps60-118-fast"]


def dominates(left: dict, right: dict) -> bool:
    objectives = ("width", "effective_fps", "vmaf_neg_mean")
    return all(left[key] >= right[key] for key in objectives) and any(
        left[key] > right[key] for key in objectives
    )


frontier = []
for order, profile in enumerate(profile_order, start=1):
    source = rows_by_profile[profile]
    row = {
        "order": order,
        "profile": profile,
        "candidate": f'{round(source["effective_fps"]):d} FPS / {source["width"]}px',
        "width": source["width"],
        "effective_fps": round(source["effective_fps"], 3),
        "stored_frames": source["stored_frames"],
        "size_bytes": source["size_bytes"],
        "size_mb": round(source["size_bytes"] / 1_000_000, 3),
        "cap_fill_pct": round(source["size_bytes"] / 2_000_000 * 100, 2),
        "vmaf": round(source["vmaf_neg_mean"], 4),
        "vmaf_p05": round(source["vmaf_neg_p05"], 4),
        "ssim": round(source["ssim_mean"], 6),
        "colors": source["colors"],
        "encoder": source["encoder"],
    }
    frontier.append(row)

for row in frontier:
    source = rows_by_profile[row["profile"]]
    row["pareto"] = not any(
        dominates(rows_by_profile[other["profile"]], source)
        for other in frontier
        if other["profile"] != row["profile"]
    )

best_quality = max(frontier, key=lambda row: row["vmaf"])
max_frames = max(frontier, key=lambda row: row["stored_frames"])
champions = [
    {
        "rank": 1,
        "role": "最高客观画质",
        "spec": f'{best_quality["width"]}px / {best_quality["effective_fps"]:.0f} FPS',
        "size_mb": best_quality["size_mb"],
        "stored_frames": best_quality["stored_frames"],
        "vmaf": best_quality["vmaf"],
        "note": "当前样片首选；帧率接近源信息上限",
    },
    {
        "rank": 2,
        "role": "最高存储帧数",
        "spec": f'{max_frames["width"]}px / {max_frames["effective_fps"]:.0f} FPS',
        "size_mb": max_frames["size_mb"],
        "stored_frames": max_frames["stored_frames"],
        "vmaf": max_frames["vmaf"],
        "note": "帧数约翻倍；VMAF 比 30 FPS 低 1.06",
    },
]

preferences = []
for run in phase1_raw["runs"]:
    if not run["profile_id"].startswith("target-"):
        continue
    objective = run["metrics"]["objective"]
    result = run["result"]
    preferences.append(
        {
            "rank": {"balanced": 1, "motion": 2, "clarity": 3}[run["profile_id"].removeprefix("target-")],
            "preference": {"balanced": "均衡", "motion": "动感", "clarity": "清晰"}[run["profile_id"].removeprefix("target-")],
            "size_mb": round(run["metrics"]["size_bytes"] / 1_000_000, 3),
            "cap_fill_pct": round(run["metrics"]["size_bytes"] / result["target_size_bytes"] * 100, 2),
            "width": result["output_width"],
            "effective_fps": round(result["effective_output_fps"], 2),
            "stored_frames": run["metrics"]["frame_count"],
            "vmaf": round(objective["vmaf_neg_mean"], 4),
            "vmaf_p05": round(objective["vmaf_neg_p05"], 4),
            "ssim": round(objective["ssim_mean"], 6),
            "attempts": result["attempts"],
            "route": result["target_optimizer_report"]["selected_route_id"],
        }
    )

features = [
    {"feature": "偏好质量闸门 + 容量再投资", "horizon": "P0", "impact": 5, "confidence": 0.95, "effort": 2, "evidence": "清晰偏好少用容量且 VMAF/P05 更差"},
    {"feature": "有效运动 FPS / 信息帧率", "horizon": "P0", "impact": 4, "confidence": 0.95, "effort": 2, "evidence": "60 FPS 存 899 帧，源仅 360 帧，画质反降"},
    {"feature": "时间戳容错的 Quality Lab", "horizon": "P0", "impact": 4, "confidence": 0.95, "effort": 2, "evidence": "15 秒尾帧 449/450 不一致会使内置评分失败"},
    {"feature": "实编码 2MB Pareto 导演", "horizon": "P0", "impact": 5, "confidence": 0.95, "effort": 3, "evidence": "30 FPS 画质冠军与 60 FPS 帧数冠军分离"},
    {"feature": "解码/调色板缓存 + 早停", "horizon": "P0", "impact": 5, "confidence": 0.80, "effort": 4, "evidence": "本地 Arena 同体积小胜但 gifski 中位约快 11.7×"},
    {"feature": "固定品牌色 + 循环接缝预算", "horizon": "P1", "impact": 4, "confidence": 0.80, "effort": 3, "evidence": "gifski 暴露固定色；GIF 对循环闪烁敏感"},
    {"feature": "批量硬帽与可分享配方", "horizon": "P1", "impact": 3, "confidence": 0.80, "effort": 3, "evidence": "Ezgif 已提供批量优化；本地复现可差异化"},
    {"feature": "可选 AI Director（DeepSeek 等）", "horizon": "P1", "impact": 3, "confidence": 0.75, "effort": 3, "evidence": "工具调用适合把自然语言映射为本地确定性函数"},
]
for row in features:
    row["priority_score"] = round(row["impact"] * row["confidence"] / row["effort"], 3)
features.sort(key=lambda row: (-row["priority_score"], row["feature"]))
for rank, row in enumerate(features, start=1):
    row["rank"] = rank

competitors = [
    {"rank": 1, "product": "GIFP 5.7.27", "target_size": "严格硬帽", "quality": "FFmpeg 调色板 + 感知路线", "workflow": "桌面编辑、多格式、交付校验", "gap": "非完整 Pareto；速度/评分器可靠性"},
    {"rank": 2, "product": "gifski 1.35.0", "target_size": "需试参，估算不精确", "quality": "跨帧调色板、时域抖动、固定颜色", "workflow": "CLI / C 库", "gap": "无严格体积编排与完整编辑器"},
    {"rank": 3, "product": "Ezgif", "target_size": "有目标体积压缩", "quality": "LZW、减色、去重、透明优化", "workflow": "Web 工具、批量优化", "gap": "不是本地桌面质量实验台"},
    {"rank": 4, "product": "ScreenToGif 2.43.2", "target_size": "官方资料未确认", "quality": "多编码器导出", "workflow": "录屏、逐帧编辑、标注/转场", "gap": "目标体积前沿不是核心卖点"},
    {"rank": 5, "product": "FFmpeg 9", "target_size": "无产品级编排", "quality": "palettegen / paletteuse", "workflow": "底层 CLI / 库", "gap": "需要上层搜索、预览、解释和校验"},
]

local_frontier_source = {
    "id": "local_2m_frontier",
    "label": "GIFP 2MB 本地质量实验",
    "path": str(FRONTIER_PATH),
    "query": {
        "engine": "duckdb",
        "language": "sql",
        "id": "gifp-2m-frontier-2026-08-31",
        "executed_at": GENERATED_AT,
        "description": "读取 Quality Lab 实编码结果，用统一独立适配器在 30 FPS、320×180 呈现画布上比较 VMAF/SSIM。",
        "sql": f"""WITH source AS (
  SELECT UNNEST(rows) AS row
  FROM read_json_auto('{FRONTIER_PATH.as_posix()}')
)
SELECT
  row.profile,
  row.size_bytes,
  row.width,
  row.effective_fps,
  row.stored_frames,
  row.colors,
  row.encoder,
  row.vmaf_neg_mean AS vmaf,
  row.vmaf_neg_p05 AS vmaf_p05,
  row.ssim_mean AS ssim
FROM source
WHERE row.profile IN ('cap-5','cap-8','cap-10','cap-12','cap-15','cap-20','cap-24','cap-30-fast','fps60-118-fast')
ORDER BY row.effective_fps""",
        "tables_used": [str(FRONTIER_PATH)],
        "filters": ["size_bytes <= 2000000", "main frontier candidates use 256 colors", "single authorized 14.984-second mixed-motion clip"],
        "metric_definitions": {
            "vmaf": "对源与 GIF 按最短共同时间轴在 30 FPS、320×180 上计算的 VMAF NEG 均值；越高越好。",
            "effective_fps": "成品实际帧数除以实际时长；不等同于唯一信息帧率。",
            "cap_fill_pct": "size_bytes / 2,000,000 × 100。",
        },
    },
}
preference_source = {
    "id": "local_target_preferences",
    "label": "GIFP 目标体积偏好实验",
    "path": str(PHASE1_PATH),
    "query": {
        "engine": "duckdb",
        "language": "sql",
        "id": "gifp-target-preferences-2026-08-31",
        "executed_at": GENERATED_AT,
        "description": "比较相同目标体积下 balanced、motion、clarity 三种偏好的最终实编码结果。",
        "sql": f"""WITH source AS (
  SELECT UNNEST(runs) AS run
  FROM read_json_auto('{PHASE1_PATH.as_posix()}')
)
SELECT
  REPLACE(run.profile_id, 'target-', '') AS preference,
  run.metrics.size_bytes,
  run.result.output_width AS width,
  run.result.effective_output_fps AS effective_fps,
  run.metrics.frame_count AS stored_frames,
  run.metrics.objective.vmaf_neg_mean AS vmaf,
  run.metrics.objective.vmaf_neg_p05 AS vmaf_p05,
  run.metrics.objective.ssim_mean AS ssim
FROM source
WHERE starts_with(run.profile_id, 'target-')""",
        "tables_used": [str(PHASE1_PATH)],
        "filters": ["profile_id starts with target-", "target_size_bytes = 1998686"],
        "metric_definitions": {
            "vmaf_p05": "逐帧 VMAF 的第 5 百分位；用于暴露局部最差时段。",
            "cap_fill_pct": "size_bytes / target_size_bytes × 100。",
        },
    },
}
def sql_literal(value: object) -> str:
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


feature_values = ",\n  ".join(
    "(" + ", ".join(sql_literal(row[field]) for field in ("rank", "horizon", "feature", "priority_score", "evidence")) + ")"
    for row in features
)
feature_source = {
    "id": "feature_priorities",
    "label": "可复算功能优先级",
    "path": str(NOTEBOOK_PATH),
    "query": {
        "engine": "duckdb",
        "language": "sql",
        "id": "gifp-feature-priorities-2026-08-31",
        "executed_at": GENERATED_AT,
        "description": "把实验和竞品证据映射为影响、置信度、成本与相对优先级。",
        "sql": f"""SELECT *
FROM (VALUES
  {feature_values}
) AS t(rank, horizon, feature, priority_score, evidence)
ORDER BY rank""",
        "tables_used": [str(FRONTIER_PATH), str(PHASE1_PATH), str(ARENA_PATH)],
        "metric_definitions": {"priority_score": "impact × confidence / effort；仅用于相对排序。"},
    },
}

competitor_values = ",\n  ".join(
    "(" + ", ".join(sql_literal(row[field]) for field in ("rank", "product", "target_size", "quality", "workflow", "gap")) + ")"
    for row in competitors
)
competitor_source = {
    "id": "competitor_research",
    "label": "官方竞品能力对比",
    "path": str(NOTEBOOK_PATH),
    "query": {
        "engine": "duckdb",
        "language": "sql",
        "id": "gifp-competitor-matrix-2026-08-31",
        "executed_at": GENERATED_AT,
        "description": "把官方文档中确认的目标体积、质量核心和工作流能力整理为产品矩阵。",
        "sql": f"""SELECT *
FROM (VALUES
  {competitor_values}
) AS t(rank, product, target_size, quality, workflow, gap)
ORDER BY rank""",
        "tables_used": ["official product documentation listed in manifest sources"],
    },
}
arena_source = {"id": "local_arena", "label": "GIFP 5.7.25 Arena 10", "path": str(ARENA_PATH)}
external_sources = [
    {"id": "gifski_readme", "label": "gifski 官方 README", "href": "https://github.com/ImageOptim/gifski"},
    {"id": "gifski_api", "label": "gifski 官方 C API", "href": "https://github.com/ImageOptim/gifski/blob/main/gifski.h"},
    {"id": "ffmpeg_filters", "label": "FFmpeg 官方滤镜文档", "href": "https://ffmpeg.org/ffmpeg-filters.html#palettegen-1"},
    {"id": "ezgif_optimize", "label": "Ezgif 官方 GIF 优化器", "href": "https://ezgif.com/optimize"},
    {"id": "screentogif_repo", "label": "ScreenToGif 官方仓库", "href": "https://github.com/NickeManarin/ScreenToGif"},
    {"id": "deepseek_api", "label": "DeepSeek API 官方文档", "href": "https://api-docs.deepseek.com/"},
    {"id": "deepseek_tools", "label": "DeepSeek Tool Calls 官方指南", "href": "https://api-docs.deepseek.com/guides/tool_calls/"},
]
sources = [local_frontier_source, preference_source, feature_source, competitor_source, arena_source, *external_sources]

manifest = {
    "version": 1,
    "surface": "report",
    "title": "GIFP 的 2MB 下一步：画质、帧数与 AI Director",
    "description": "面向产品迭代的单素材实测、竞品对比与功能路线建议。",
    "generatedAt": GENERATED_AT,
    "blocks": [
        {"id": "title", "type": "markdown", "body": "# GIFP 的 2MB 下一步：画质、帧数与 AI Director"},
        {
            "id": "executive_summary",
            "type": "markdown",
            "body": "## Executive Summary\n\n- 在当前 15 秒混合运动样片中，2MB 内最高客观画质是 **120px / 30 FPS / 450 帧 / 1.929MB**；最高帧数是 **118px / 60 FPS / 899 帧 / 1.960MB**，但 VMAF 低约 1.06。\n- 当前‘清晰优先’只多 4px，却少用约 6.6 个百分点容量、有效帧率降到 17.7，且平均/P05 VMAF 都更差；应先做质量闸门与完整 Pareto 候选。\n- DeepSeek 更适合作为可选的自然语言导演层，通过工具调用编排本地确定性分析/编码；不应进入逐次体积搜索或取代字节/VMAF 校验。",
        },
        {"id": "finding_2m", "type": "markdown", "sourceId": "local_2m_frontier", "body": "## 2MB 下：30 FPS 是画质冠军，60 FPS 是帧数冠军\n\n9 个主候选都通过十进制 2,000,000 字节硬帽。对这份约 24 源 FPS 的素材，继续把成品抬到 60 FPS 主要增加显示采样，而不是等量增加新信息。"},
        {"id": "champions_block", "type": "table", "tableId": "champions_table"},
        {"id": "frontier_chart_block", "type": "chart", "chartId": "frontier_chart"},
        {"id": "frontier_interpretation", "type": "markdown", "sourceId": "local_2m_frontier", "body": "**Interpretation.** 在接近同一体积时，本样片把字节花在 30 FPS 的空间/调色板质量上，比 60 FPS 重采样更划算；但这不是普遍的‘30 FPS 规则’，而是需要由内容驱动的候选前沿。"},
        {"id": "preference_section", "type": "markdown", "sourceId": "local_target_preferences", "body": "## 当前偏好不是完整 Pareto\n\n现有搜索会在命中目标区间后停止，并主要沿宽度、帧率、颜色阶梯缩减；再投资也没有重新探索 FPS。结果是标签叫‘清晰’，却可能容量未吃满且综合画质更差。"},
        {"id": "preference_table_block", "type": "table", "tableId": "preference_table"},
        {"id": "competition_section", "type": "markdown", "body": "## 竞争格局：硬帽仍是优势，但已不够独特\n\n**gifski** 的跨帧调色板、时域抖动和固定颜色值得吸收，但官方仍要求为预设体积反复试参；**Ezgif** 已提供目标体积、批量、丢帧/去重与透明优化；**ScreenToGif** 则把录屏与逐帧编辑做成了完整工作流。GIFP 的机会是把‘本地严格硬帽 + 可解释质量前沿 + 编辑/多格式交付’做成一个系统。"},
        {"id": "competitor_table_block", "type": "table", "tableId": "competitor_table"},
        {"id": "deepseek_section", "type": "markdown", "body": "## DeepSeek API：做导演层，不做编码器\n\nDeepSeek 当前提供 OpenAI/Anthropic 兼容接口、JSON 输出和工具调用；因此建议实现供应商可替换的 `AI Director`。模型只接收本地探测出的结构化元数据（默认不上传原视频），并可调用 `analyze_source`、`generate_pareto_candidates`、`preview_candidate`、`encode_verified_target`。本地策略层负责路径、参数白名单、2MB 硬帽、最终实编码与质量校验。\n\n首批场景应是：自然语言配方（‘2MB 内保人物动作、循环别闪’）、候选解释、失败诊断、批量命名/文案；视觉模型只在用户选择后读取抽样联系表，用于主体/文字 ROI 与字幕避让。"},
        {"id": "recommendations_section", "type": "markdown", "body": "## Recommended next steps\n\n先修会让当前结果选错或无法评分的 P0，再做差异化 P1。优先级分数为 `影响 × 置信度 ÷ 成本`，只表示相对顺序。"},
        {"id": "feature_table_block", "type": "table", "tableId": "feature_table"},
        {"id": "further_questions", "type": "markdown", "body": "## Further questions\n\n1. 在低照度、动态海报、UI 录屏、像素画、人像、渐变和透明素材上，30/60 FPS 的分界如何变化？\n2. 用户更愿意选择‘最清晰 / 最顺滑 / 最大画面’三个实预览，还是接受一个自动结果？\n3. AI Director 首版应只做文本配方，还是同时开放可选联系表视觉分析？"},
        {"id": "caveats", "type": "markdown", "body": "## Caveats and assumptions\n\n- 结论来自单份授权真实素材和 dirty 开发工作树，适合决定下一轮实验，不适合对外排名。\n- 60 FPS 的信息重复按源帧数上限推断，不是逐帧哈希去重；产品中应计算运动/差分加权的有效信息帧率。\n- 本地 Arena 的 gifski 是 1.34.0，而官方仓库当前为 1.35.0；下一轮需要更新对手、冻结干净提交并扩到许可清晰的真实素材集。\n- VMAF/SSIM 不能替代循环接缝、文字边缘、颜色稳定性、时域抖动和人工盲测。"},
    ],
    "charts": [
        {
            "id": "frontier_chart",
            "title": "2MB 候选的有效帧率与 VMAF",
            "description": "30 FPS 达到本样片最高 VMAF；60 FPS 增加存储帧数但没有增加客观画质。",
            "type": "line",
            "dataset": "frontier",
            "sourceId": "local_2m_frontier",
            "encodings": {
                "x": {"field": "effective_fps", "type": "quantitative"},
                "y": {"field": "vmaf", "type": "quantitative"},
            },
        }
    ],
    "tables": [
        {
            "id": "champions_table",
            "title": "2MB 双冠军",
            "dataset": "champions",
            "sourceId": "local_2m_frontier",
            "columns": [
                {"field": "rank", "label": "序"},
                {"field": "role", "label": "角色"},
                {"field": "spec", "label": "规格"},
                {"field": "size_mb", "label": "体积 MB"},
                {"field": "stored_frames", "label": "存储帧"},
                {"field": "vmaf", "label": "VMAF"},
                {"field": "note", "label": "解读"},
            ],
            "defaultSort": {"field": "rank", "direction": "asc"},
        },
        {
            "id": "preference_table",
            "title": "目标体积偏好实编码结果",
            "dataset": "preferences",
            "sourceId": "local_target_preferences",
            "columns": [
                {"field": "rank", "label": "序"},
                {"field": "preference", "label": "偏好"},
                {"field": "size_mb", "label": "体积 MB"},
                {"field": "cap_fill_pct", "label": "容量使用 %"},
                {"field": "width", "label": "宽 px"},
                {"field": "effective_fps", "label": "有效 FPS"},
                {"field": "stored_frames", "label": "帧数"},
                {"field": "vmaf", "label": "VMAF"},
                {"field": "vmaf_p05", "label": "P05 VMAF"},
            ],
            "defaultSort": {"field": "rank", "direction": "asc"},
        },
        {
            "id": "competitor_table",
            "title": "能力矩阵",
            "dataset": "competitors",
            "sourceId": "competitor_research",
            "columns": [
                {"field": "rank", "label": "序"},
                {"field": "product", "label": "产品"},
                {"field": "target_size", "label": "目标体积"},
                {"field": "quality", "label": "画质核心"},
                {"field": "workflow", "label": "工作流"},
                {"field": "gap", "label": "主要差距"},
            ],
            "defaultSort": {"field": "rank", "direction": "asc"},
        },
        {
            "id": "feature_table",
            "title": "功能优先级",
            "dataset": "features",
            "sourceId": "feature_priorities",
            "columns": [
                {"field": "rank", "label": "优先"},
                {"field": "horizon", "label": "阶段"},
                {"field": "feature", "label": "功能"},
                {"field": "priority_score", "label": "相对分"},
                {"field": "evidence", "label": "直接证据"},
            ],
            "defaultSort": {"field": "rank", "direction": "asc"},
        },
    ],
    "sources": sources,
}

artifact = {
    "surface": "report",
    "manifest": manifest,
    "snapshot": {
        "version": 1,
        "generatedAt": GENERATED_AT,
        "status": "ready",
        "datasets": {
            "frontier": frontier,
            "champions": champions,
            "preferences": preferences,
            "competitors": competitors,
            "features": features,
        },
    },
    "sources": sources,
}

assert best_quality["profile"] == "cap-30-fast"
assert max_frames["profile"] == "fps60-118-fast"
assert all(row["size_bytes"] <= 2_000_000 for row in frontier)
assert len(artifact["manifest"]["charts"]) >= 1

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Artifact: {OUTPUT}")
