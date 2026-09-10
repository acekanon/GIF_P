import { AnimatedSelect } from "./AnimatedSelect";
import {
  COMPRESSION_PRESETS,
  type CompressionPresetId,
} from "./editorModel";

type Props = {
  value: CompressionPresetId;
  onChange: (value: CompressionPresetId) => void;
};

export function CompressionPresetSelect({ value, onChange }: Props) {
  return (
    <AnimatedSelect
      ariaLabel="压缩预设"
      value={value}
      options={COMPRESSION_PRESETS.map((preset) => ({
        value: preset.id,
        label: preset.label,
        note: preset.description,
      }))}
      onChange={onChange}
    />
  );
}
