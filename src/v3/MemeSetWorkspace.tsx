import type { ReactNode } from "react";
import "./meme-set.css";
import { MemeWorkspace, type MemeWorkspaceProps } from "./MemeWorkspace";
import { addMemeItem, editMemeItem, removeMemeItem, memeExportItems, MEME_SET_LIMIT, type MemeCollection } from "./memeCollectionModel";

const statusText = { draft: "待生成", queued: "排队中", running: "生成中", completed: "已生成", failed: "失败", cancelled: "已停止" };
type Props = Omit<MemeWorkspaceProps, "value" | "onDraftChange"> & {
  collection: MemeCollection;
  onChange: (collection: MemeCollection) => void;
  busy: boolean;
  canExport: boolean;
  onGenerate: (retry: boolean) => void;
  onCancel: () => void;
  onOpen: (path?: string) => void;
  outputControls?: ReactNode;
};
export function MemeSetWorkspace({ collection, onChange, busy, canExport, onGenerate, onCancel, onOpen, ...props }: Props) {
  const selected = collection.items.find(item => item.id === collection.selectedId) ?? collection.items[0];
  const completed = collection.items.filter(item => item.status === "completed");
  const failed = collection.items.filter(item => item.status === "failed");
  const pending = memeExportItems(collection, false);
  const hasBlank = pending.some(item => !item.settings.topText.trim() && !item.settings.bottomText.trim());
  const add = (duplicate: boolean) => onChange(addMemeItem(collection, crypto.randomUUID(), duplicate));
  return <MemeWorkspace {...props} draftId={selected.id} value={selected.settings} readOnly={busy}
    outputControls={<>{props.outputControls}<details className="meme-set-output"><summary>单张与高级编辑</summary>
      <button disabled={busy || !props.asset} onClick={() => props.onApply(selected.settings)}>应用到导出</button>
      {props.onQuickExport && <button disabled={busy || !props.asset} onClick={() => props.onQuickExport?.(selected.settings)}>快速导出表情包</button>}
    </details></>}
    onDraftChange={settings => onChange(editMemeItem(collection, selected.id, settings))}
    collectionBar={<section className="meme-set" aria-label="表情包成组列表">
      <div className="meme-set-heading"><strong>我的表情组 <small>{collection.items.length} / {MEME_SET_LIMIT}</small></strong>
        <div><button disabled={busy || collection.items.length >= MEME_SET_LIMIT} onClick={() => add(false)}>＋ 新增文案</button><button disabled={busy || collection.items.length >= MEME_SET_LIMIT} onClick={() => add(true)}>复制当前</button><button disabled={busy || collection.items.length === 1} onClick={() => onChange(removeMemeItem(collection, selected.id))}>删除当前</button></div>
      </div>
      <div className="meme-set-list" role="group" aria-label="选择表情">
        {collection.items.map((item, index) => <button key={item.id} aria-pressed={item.id === selected.id} className={`meme-set-card status-${item.status}`} onClick={() => onChange({ ...collection, selectedId: item.id })} title={item.error || item.result?.output_path || [item.settings.topText, item.settings.bottomText].filter(Boolean).join(" / ")}>
          {props.asset?.thumbnailUrl && <img src={props.asset.thumbnailUrl} alt="" />}
          <span><strong>{index + 1}. {[item.settings.topText, item.settings.bottomText].filter(Boolean).join(" / ") || "写一句新文案"}</strong><small>{statusText[item.status]}</small></span>
        </button>)}
      </div>
    </section>}
    collectionFooter={<footer className="meme-set-footer">
      <div className="meme-set-summary" aria-live="polite">
        <strong>{busy ? "正在制作这一组…" : `已生成 ${completed.length} / ${collection.items.length}`}</strong>
        <small title={selected.error || selected.result?.output_path}>{selected.error || (selected.result ? selected.result.output_path.split(/[\\/]/).pop() : !canExport ? "桌面版可生成文件；此处可编辑预览" : hasBlank ? "请为每张表情填写文案" : "统一输出 GIF · 沿用当前素材的裁剪与时段")}</small>
      </div>
      {selected.result && <button onClick={() => onOpen(selected.result!.output_path)}>打开文件夹</button>}
      {!busy && failed.length > 0 && <button disabled={!canExport} onClick={() => onGenerate(true)}>重试失败 {failed.length}</button>}
      {busy ? <button onClick={onCancel}>停止生成</button> : <button className="meme-export-button" disabled={!props.asset || !canExport || hasBlank} onClick={() => onGenerate(false)}>{completed.length === collection.items.length ? "重新生成整组" : completed.length ? "生成未完成" : "生成整组"} {pending.length}</button>}
    </footer>}
  />;
}
