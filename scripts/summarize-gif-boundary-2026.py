from pathlib import Path
import importlib.util, json
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT/"audits/2026-09-09-gif-boundary"
rows=json.loads((WORK/"results-metrics.json").read_text(encoding="utf-8"))
spec=importlib.util.spec_from_file_location("gif_verifier",ROOT/"scripts/benchmark-gifsicle-incremental.py")
verifier=importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
verified=[]
for row in rows:
    if not row["method"].endswith("-o3"): continue
    original=next(r for r in rows if r["source"]==row["source"] and r["method"]==row["method"][:-3])
    result=verifier.inspect_pair(ROOT/"release/GIFP-5.7.27/ffmpeg.exe",Path(original["path"]),Path(row["path"]))
    assert result["verified_equal"]
    verified.append(dict(source=row["source"],method=row["method"],**result))
(WORK/"o3-verification.json").write_text(json.dumps(verified,indent=2),encoding="utf-8")

fig,axes=plt.subplots(2,2,figsize=(12,8))
for ax,source in zip(axes.flat,["local-ui","smooth-gradient","moving-pattern","noisy-motion"]):
    subset=[r for r in rows if r["source"]==source]
    for method,label,color,marker in [("gifp-fast-baseline","GIFP Fast","#858a91","s"),("gifp-best-current","GIFP Best","#268f87","D")]:
        row=next(r for r in subset if r["method"]==method)
        ax.scatter(row["bytes"]/1024,row["rgb_psnr_db"],color=color,marker=marker,s=75,label=label,zorder=3)
        opt=next(r for r in subset if r["method"]==method+"-o3")
        ax.scatter(opt["bytes"]/1024,opt["rgb_psnr_db"],facecolors="none",edgecolors=color,marker=marker,s=75,zorder=3)
    points=[next(r for r in subset if r["method"]==f"gifski-q{q}"+("-motion100" if source=="smooth-gradient" and q<100 else "")) for q in [100,80,60,40,20]]
    ax.plot([r["bytes"]/1024 for r in points],[r["rgb_psnr_db"] for r in points],"o-",color="#c87449",label="gifski Q100 to Q20")
    if source=="smooth-gradient":
        others=[r for r in subset if r["method"] in ["gifski-q80","gifski-q60","gifski-q40","gifski-q20"]]
        ax.scatter([r["bytes"]/1024 for r in others],[r["rgb_psnr_db"] for r in others],marker="x",color="#a6a6a6",label="default motion (55-59 frames)")
    ax.set_xscale("log"); ax.set_title(source); ax.set_xlabel("File size (KiB, log scale)"); ax.set_ylabel("RGB PSNR (dB)")
    ax.grid(alpha=.18); ax.legend(fontsize=8)
fig.suptitle("854 x 480 | 12 input FPS | 5 seconds | synthetic examples",fontsize=14)
fig.text(.5,.01,"Hollow markers: verified lossless O3. PSNR is not a perceptual quality verdict. No minimum-size proof.",ha="center",fontsize=9)
fig.tight_layout(rect=[0,.035,1,.96]); fig.savefig(WORK/"rate-quality.png",dpi=170); plt.close(fig)

def at_time(path,ms=2500):
    with Image.open(path) as im:
        end=0
        for frame in range(im.n_frames):
            im.seek(frame);end+=im.info.get("duration",0)
            if end>ms:return im.convert("RGB").copy()
        return im.convert("RGB").copy()

fig,axes=plt.subplots(2,3,figsize=(12,5.7))
for i,source in enumerate(["smooth-gradient","noisy-motion"]):
    best=next(r for r in rows if r["source"]==source and r["method"]=="gifp-best-current")
    small=next(r for r in rows if r["source"]==source and r["method"]==("gifski-q60-motion100" if i==0 else "gifski-q20"))
    panels=[(Image.open(WORK/"png"/source/"031.png"),"Source at 2.5s"),(at_time(best["path"]),f"GIFP Best / {best['bytes']/1048576:.2f} MiB"),(at_time(small["path"]),f"gifski Q{60 if i==0 else 20} / {small['bytes']/1048576:.2f} MiB")]
    for j,(im,label) in enumerate(panels):
        axes[i,j].imshow(im);axes[i,j].axis("off");axes[i,j].set_title(source+"\n"+label,fontsize=10)
fig.suptitle("Smaller files can change texture and gradients; all shown candidates store 60 frames",fontsize=11)
fig.tight_layout();fig.savefig(WORK/"frame-comparison.png",dpi=170);plt.close(fig)
print("Verified",len(verified),"O3 pairs and wrote two figures")
