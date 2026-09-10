import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommittedNumberInput } from "./CommittedNumberInput";

afterEach(cleanup);

function setup() {
  const onCommit = vi.fn();
  const onSave = vi.fn();
  function Editor() {
    const [width, setWidth] = useState(420);
    return <>
      <CommittedNumberInput ariaLabel="宽度" value={width} min={96} max={1920} step={2} onCommit={(value) => { onCommit(value); setWidth(value); }} />
      <button onClick={() => onSave(width)}>保存</button>
    </>;
  }
  render(<Editor />);
  return { user: userEvent.setup(), input: screen.getByRole("spinbutton", { name: "宽度" }), onCommit, onSave };
}

describe("CommittedNumberInput", () => {
  it("keeps partial typing local and commits before the next action reads the value", async () => {
    const { user, input, onCommit, onSave } = setup();
    await user.clear(input);
    await user.type(input, "500");
    expect(onCommit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(500);
    expect(onSave).toHaveBeenCalledExactlyOnceWith(500);
  });

  it("discards on Escape without committing on the resulting blur or closing the parent", async () => {
    const { user, input, onCommit } = setup();
    const escape = vi.fn();
    document.addEventListener("keydown", escape);
    try {
      await user.clear(input);
      await user.type(input, "700");
      escape.mockClear();
      await user.keyboard("{Escape}");
      expect(input).toHaveValue(420);
      expect(input).not.toHaveFocus();
      expect(onCommit).not.toHaveBeenCalled();
      expect(escape).not.toHaveBeenCalled();
      await user.clear(input);
      await user.type(input, "600{Enter}");
      expect(onCommit).toHaveBeenCalledExactlyOnceWith(600);
    } finally {
      document.removeEventListener("keydown", escape);
    }
  });

  it("restores an empty draft and normalizes committed steps and bounds", async () => {
    const { user, input, onCommit } = setup();
    await user.clear(input);
    await user.tab();
    expect(input).toHaveValue(420);
    expect(onCommit).not.toHaveBeenCalled();
    for (const [draft, expected] of [["501", 502], ["9000", 1920], ["2", 96]] as const) {
      await user.clear(input);
      await user.type(input, `${draft}{Enter}`);
      expect(input).toHaveValue(expected);
      expect(onCommit).toHaveBeenLastCalledWith(expected);
    }
  });
});
