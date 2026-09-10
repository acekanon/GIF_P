"""Compare files on the same 60 presentation instants, not stored GIF frame index."""
from pathlib import Path
import json, math
import numpy as np
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/"audits/2026-09-09-gif-boundary"
rows=json.loads((WORK/"results.json").read_text(encoding="utf-8"))
references={}
def reference(source):
    if source not in references:
        references.clear()
        references[source]=[np.asarray(Image.open(p).convert("RGB"),dtype=np.int16) for p in sorted((WORK/"png"/source).glob("*.png"))]
    return references[source]

for row in sorted(rows,key=lambda r:r["source"]):
    if "path" not in row: continue
    refs=reference(row["source"])
    assert len(refs)==60
    mse=0.0
    with Image.open(row["path"]) as im:
        assert im.size==(854,480)
        frame=0
        end=im.info.get("duration",0)
        for i,ref in enumerate(refs):
            t=(i+0.5)*1000/12
            while t>=end and frame+1<im.n_frames:
                frame+=1
                im.seek(frame)
                end+=im.info.get("duration",0)
            error=np.asarray(im.convert("RGB"),dtype=np.int16)-ref
            mse+=float(np.mean(error.astype(np.float32)**2))
        mse/=60
        row["rgb_psnr_db"]=round(10*math.log10(255**2/mse),3) if mse>0 else None
        row["exact_5s"]=row["inspection"]["duration_ms"]==5000
        row["bpp_per_source_frame"]=round(8*row["bytes"]/(854*480*60),5)

(WORK/"results-metrics.json").write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding="utf-8")
lines=["# 854×480 / 12 FPS / 5 秒：合成边界实验", "", "四个合成源，各 60 个输入采样。不是实际素材排行榜，也不构成最低体积证明。RGB PSNR 在相同的 60 个展示时刻测量，不能代替对文字、纹理、色带和时域闪烁的检查。不同工具的质量参数不等价。", "", "| 场景 | 方法 | KiB | 存储帧数 | 时长 ms | RGB PSNR dB |", "|---|---|---:|---:|---:|---:|"]
for row in rows:
    if "path" not in row:
        lines.append(f"| {row['source']} | {row['method']} | 失败 | | | |")
        continue
    lines.append(f"| {row['source']} | {row['method']} | {row['bytes']/1024:.1f} | {row['inspection']['frames']} | {row['inspection']['duration_ms']} | {row['rgb_psnr_db']} |")
(WORK/"results.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
print("\n".join(lines))
