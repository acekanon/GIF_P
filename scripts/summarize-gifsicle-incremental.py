from pathlib import Path
from statistics import median
from zipfile import ZipFile, ZIP_DEFLATED
import argparse
import importlib.util
import json
import time
import hashlib
import PIL

spec=importlib.util.spec_from_file_location('gifsicle_pilot',Path(__file__).with_name('benchmark-gifsicle-incremental.py'))
pilot=importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


def summarize(report_path, ffmpeg):
    report=json.loads(report_path.read_text(encoding='utf-8'))
    if report['status']!='completed':raise ValueError('An incomplete experiment cannot be summarized')
    rows=report['rows']
    if len({r['id'] for r in rows})!=len(rows):raise ValueError('Duplicate input IDs')
    for row in rows:
        source=Path(row['path'])
        if pilot.sha(source)!=row['source_sha256']:
            raise ValueError('Input or candidate changed after measurement')
        if row['error'] or row['tool_errors'] or not row['candidate_path']:
            if row['eligible']:raise ValueError('Failed candidates cannot be selected')
            row.update(final_verification_ms=0,final_verification={'verified_equal':False},selected_saving_percent=0,selected_path=str(source))
            continue
        candidate=Path(row['candidate_path'])
        if pilot.sha(candidate)!=row['candidate_sha256']:
            raise ValueError('Input or candidate changed after measurement')
        start=time.perf_counter_ns()
        verification=pilot.inspect_pair(ffmpeg,source,candidate)
        row['final_verification_ms']=(time.perf_counter_ns()-start)/1e6
        row['final_verification']=verification
        eligible=verification['verified_equal'] and candidate.stat().st_size<source.stat().st_size
        if eligible!=row['eligible']:raise ValueError('Final verifier changed the selection; inspect manually')
        row['selected_path']=str(candidate if eligible else source)
        row['selected_saving_percent']=(1-candidate.stat().st_size/source.stat().st_size)*100 if eligible else 0
    groups=[]
    for name in dict.fromkeys(row['group'] for row in rows):
        items=[r for r in rows if r['group']==name]
        groups.append({'group':name,'count':len(items),'selected':sum(r['eligible'] for r in items),
            'median_selected_saving_percent':median(r['selected_saving_percent'] for r in items),
            'optimizer_median_ms':median(r['optimizer_median_ms'] for r in items),
            'verification_median_ms':median(r['final_verification_ms'] for r in items)})
    summary={'inputs':len(rows),'selected':sum(r['eligible'] for r in rows),'all_dual_decoder_equal':all(r['final_verification']['verified_equal'] for r in rows),
        'groups':groups,'scope':'Existing synthetic P2 artifacts; correlated modes, not independent real-world samples.'}
    output=report_path.parent.parent
    (output/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    (output/'final-verification.json').write_text(json.dumps({'verifier_sha256':pilot.sha(Path(pilot.__file__)),'ffmpeg_sha256':pilot.sha(ffmpeg),'pillow_version':PIL.__version__,'rows':rows},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    lines=['# Gifsicle 增量结果','', '15 份成品来自四个合成源的 Fast／Best／体积模式和三份已优化透明样本。仅运行 `-O3`，不修改原文件。画面、时序与循环同时经过 Pillow 和 FFmpeg 检查。','',
        '| 组别 | 采用／总数 | 最终体积节省中位数 | 优化 P50/ms | 最终验证 P50/ms |','|---|---:|---:|---:|---:|']
    for g in groups:lines.append(f"| {g['group']} | {g['selected']}/{g['count']} | {g['median_selected_saving_percent']:.1f}% | {g['optimizer_median_ms']:.1f} | {g['verification_median_ms']:.1f} |")
    lines += ['', '不采用的文件按节省 0% 计入，避免只汇报获胜项。验证耗时单独测量，不等同于原生适配器未来的精确成本。','',
        '| 文件 | 原字节 | 候选字节 | 是否采用 |','|---|---:|---:|---|']
    for row in rows:lines.append(f"| {row['id']} | {row['source_bytes']} | {row['candidate_bytes']} | {'是' if row['eligible'] else '保留原件'} |")
    lines += ['', '结论：适合评估“更小优先”的按需后处理；不应无条件追加到 Fast 或已优化透明输出。未接入默认桌面导出链，未增加发行依赖。','']
    (output/'summary.md').write_text('\n'.join(lines),encoding='utf-8')
    selections=[]
    with ZipFile(output/'selected-gifs.zip','w',compression=ZIP_DEFLATED) as archive:
        for index,row in enumerate(rows):
            name=f'{index:03d}.gif';selected=Path(row['selected_path'])
            data=selected.read_bytes();digest=hashlib.sha256(data).hexdigest()
            expected=row['candidate_sha256'] if row['eligible'] else row['source_sha256']
            if digest!=expected:raise ValueError('Selected file changed after verification')
            archive.writestr(name,data)
            selections.append({'file':name,'id':row['id'],'optimized':row['eligible'],'sha256':digest})
        archive.writestr('manifest.json',json.dumps({'scope':'synthetic experiment outputs, not a platform sticker pack','files':selections},ensure_ascii=False,indent=2))
    print(json.dumps(summary,ensure_ascii=False,indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('report',type=Path)
    parser.add_argument('--ffmpeg',type=Path,required=True)
    args=parser.parse_args()
    summarize(args.report,args.ffmpeg.resolve())
