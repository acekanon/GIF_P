"""Small synthetic size frontier study. Does not change application defaults."""
from pathlib import Path
import hashlib, json, os, subprocess, sys, time

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "audits/2026-09-09-gif-boundary"
FFMPEG = ROOT / "release/GIFP-5.7.27/ffmpeg.exe"
FFPROBE = FFMPEG.with_name("ffprobe.exe")
GIFSKI = ROOT / "tmp/gifski-pk/tool/bin/gifski.exe"
GIFSICLE = ROOT / "tmp/arena10-competitors/gifsicle-study/tool/gifsicle-1.96/src/gifsicle.exe"
LAB = ROOT / "src-tauri/target/release/gifp_quality_lab.exe"

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def run(args, timeout=300):
    started = time.perf_counter()
    result = subprocess.run([str(x) for x in args], capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", "replace")[-4000:])
    return result.stdout, round(time.perf_counter()-started, 3)

def save(name, data):
    (WORK/name).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

def inspect(path):
    from PIL import Image
    with Image.open(path) as image:
        duration = 0
        delays = []
        for i in range(image.n_frames):
            image.seek(i)
            delays.append(image.info.get("duration", 0))
        return dict(width=image.width, height=image.height, frames=image.n_frames,
                    duration_ms=sum(delays), delays_ms=delays, loop=image.info.get("loop"))

def prepare():
    WORK.mkdir(parents=True, exist_ok=True)
    sources = WORK/"sources"
    sources.mkdir(exist_ok=True)
    (WORK/"fixtures").mkdir(exist_ok=True)
    specs = [
        ("local-ui", "color=c=0xF3EEDF:s=854x480:r=12:d=5", "drawgrid=w=85:h=48:t=1:c=0xC8BFA7,drawbox=x=60:y=70:w=730:h=330:color=0xD9D2C1:t=fill,drawbox=x=670:y=210:w=52:h=52:color=0x42B883:t=fill:enable='lt(mod(t,1),0.25)'"),
        ("smooth-gradient", "gradients=s=854x480:r=12:d=5:c0=0xF4D0BD:c1=0xC98776:c2=0x4B3548:n=3:x0=0:y0=0:x1=854:y1=480:speed=0.04:seed=101", "format=yuv444p"),
        ("moving-pattern", "testsrc2=s=854x480:r=12:d=5", "format=yuv444p"),
        ("noisy-motion", "testsrc2=s=854x480:r=12:d=5", "noise=alls=35:allf=t+u:all_seed=20260909,format=yuv444p"),
    ]
    base = json.loads((ROOT/"bench/arena10-manifest.json").read_text(encoding="utf-8"))
    manifest = dict(schema_version=1, corpus_id="gifp-boundary-480p-12fps-5s-v1",
        description="Synthetic boundary examples, not a real-world quality ranking. Source timeline: 60 frames / 5 seconds.",
        fixture_root="fixtures", canonical_fixture_identity=base["canonical_fixture_identity"], fixtures=[], profiles=[])
    identity = manifest["canonical_fixture_identity"]
    runtime = ROOT/"compliance/ffmpeg-windows-x64-gpl-shared.json"
    identity.update(generator_ffmpeg_sha256=sha(FFMPEG), generator_ffprobe_sha256=sha(FFPROBE),
        reviewed_runtime_manifest_path=runtime.relative_to(ROOT).as_posix(), reviewed_runtime_manifest_sha256=sha(runtime))
    for ident, source, filters in specs:
        destination = sources/f"{ident}.mkv"
        if not destination.exists():
            run([FFMPEG,"-v","error","-f","lavfi","-i",source,"-vf",filters,"-frames:v","60","-c:v","ffv1","-pix_fmt","yuv444p",destination])
        fixture = WORK/"fixtures"/destination.name
        run([FFMPEG,"-y","-hide_banner","-loglevel","error","-i",destination,"-t","5.000000","-an",
            "-c:v","ffv1","-level","3","-g","1","-threads","1","-pix_fmt","yuv444p",
            "-fflags","+bitexact","-flags:v","+bitexact","-map_metadata","-1",fixture])
        manifest["fixtures"].append(dict(id=ident, category=ident, file=f"{ident}.mkv", expected_source_sha256=sha(fixture),
            duration_seconds=5.0, tags=["synthetic", "480p", "12fps"], generator=dict(kind="external", input=destination.relative_to(WORK).as_posix(),
                source_sha256=sha(destination), authorization="Generated locally by this study from lavfi; no external media.",pixel_format="yuv444p")))
    for original in base["profiles"]:
        profile = dict(original)
        profile.update(id="fast-baseline" if profile["generation_mode"]=="fast_gif" else "best-current", width=854, fps=12)
        manifest["profiles"].append(profile)
    save("manifest.json", manifest)
    save("toolchain.json", {str(p.relative_to(ROOT)):sha(p) for p in [FFMPEG,FFPROBE,GIFSKI,GIFSICLE,LAB]})
    return manifest

def main():
    manifest = prepare()
    os.environ["GIFP_FFMPEG_DIR"] = str(FFMPEG.parent)
    os.environ["PATH"] = str(FFMPEG.parent)+os.pathsep+os.environ["PATH"]
    report = WORK/"gifp-lab.json"
    if not report.exists():
        print("Running current GIFP Fast/Best on four 480p clips", flush=True)
        result = subprocess.run([str(LAB),"run","--manifest",str(WORK/"manifest.json"),"--output",str(report)],capture_output=True,timeout=1200)
        (WORK/"gifp-lab.log").write_bytes(result.stdout+b"\n"+result.stderr)
        if result.returncode: raise RuntimeError(result.stderr.decode("utf-8","replace")[-4000:])
    lab = json.loads(report.read_text(encoding="utf-8"))
    rows=[]
    for record in lab["runs"]:
        if record["status"] != "ok":
            rows.append(dict(source=record["fixture_id"],method="gifp-"+record["profile_id"],error=record["error"]))
            continue
        result=record["result"]
        path=Path(result["output_path"])
        rows.append(dict(source=record["fixture_id"],method="gifp-"+record["profile_id"],path=str(path),bytes=path.stat().st_size,
            seconds=result["elapsed_ms"]/1000,inspection=inspect(path)))
        optimized=WORK/f"{record['fixture_id']}-{record['profile_id']}-o3.gif"
        _, seconds=run([GIFSICLE,"-O3",path,"-o",optimized])
        rows.append(dict(source=record["fixture_id"],method="gifp-"+record["profile_id"]+"-o3",path=str(optimized),bytes=optimized.stat().st_size,
            seconds=seconds,inspection=inspect(optimized)))
    for source in manifest["fixtures"]:
        ident=source["id"]
        folder=WORK/"png"/ident
        folder.mkdir(parents=True,exist_ok=True)
        _, extract_s=run([FFMPEG,"-v","error","-i",WORK/source["generator"]["input"],"-vf","fps=12,format=rgba","-frames:v","60","-y",folder/"%03d.png"])
        frames=sorted(folder.glob("*.png"))
        assert len(frames)==60
        for quality in [100,80,60,40,20]:
            path=WORK/f"{ident}-gifski-q{quality}.gif"
            _, seconds=run([GIFSKI,"--quiet","--no-sort","--fps","12","--quality",quality,"--repeat","0","-o",path,*frames])
            rows.append(dict(source=ident,method=f"gifski-q{quality}",path=str(path),bytes=path.stat().st_size,seconds=seconds,
                extract_seconds=extract_s,inspection=inspect(path)))
        save("results.json",rows)
        print("Finished",ident,flush=True)
    save("results.json",rows)
    for row in rows:
        print(row["source"],row["method"],row.get("bytes"),row.get("inspection",{}).get("duration_ms"),flush=True)

def motion_check():
    rows=json.loads((WORK/"results.json").read_text(encoding="utf-8"))
    source="smooth-gradient"
    frames=sorted((WORK/"png"/source).glob("*.png"))
    for quality in [80,60,40,20]:
        method=f"gifski-q{quality}-motion100"
        if any(row["method"]==method for row in rows): continue
        path=WORK/f"{source}-{method}.gif"
        _, seconds=run([GIFSKI,"--quiet","--no-sort","--fps","12","--quality",quality,"--motion-quality","100","--repeat","0","-o",path,*frames])
        rows.append(dict(source=source,method=method,path=str(path),bytes=path.stat().st_size,seconds=seconds,inspection=inspect(path)))
        print(method, rows[-1]["bytes"], rows[-1]["inspection"]["frames"],flush=True)
    save("results.json",rows)

if __name__=="__main__":
    if "--motion-check" in sys.argv: motion_check()
    else: main()
