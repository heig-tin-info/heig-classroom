import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { useConfirm, type ConfirmOptions } from "./confirm";
import { renderWithProviders } from "./test/render";

/*
 * `useConfirm` is the replacement for `window.confirm` (banned by the UI
 * skill), so what it promises is a promise: true only when the user said so.
 */

function ConfirmHarness({ options, label }: { options: ConfirmOptions; label: string }) {
  const confirm = useConfirm();
  const [answer, setAnswer] = useState("pending");
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void confirm(options).then((ok) => setAnswer(String(ok)));
        }}
      >
        {label}
      </button>
      <p data-testid={`answer-${label}`}>{answer}</p>
    </>
  );
}

const archive: ConfirmOptions = {
  title: "Archive “PRG1 2026”?",
  message: "The classroom disappears until you restore it.",
  confirmLabel: "Archive classroom",
};

const ask = async (options: ConfirmOptions = archive, label = "Ask") => {
  renderWithProviders(<ConfirmHarness options={options} label={label} />);
  await userEvent.click(screen.getByRole("button", { name: label }));
  return {
    dialog: await screen.findByRole("dialog"),
    answer: () => screen.getByTestId(`answer-${label}`).textContent,
  };
};

describe("useConfirm", () => {
  it("shows the title and the message of the caller", async () => {
    const { dialog } = await ask();
    expect(dialog).toHaveAccessibleName("Archive “PRG1 2026”?");
    expect(
      within(dialog).getByText("The classroom disappears until you restore it."),
    ).toBeVisible();
  });

  it("resolves true on the confirm button", async () => {
    const { dialog, answer } = await ask();
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive classroom" }));
    await waitFor(() => expect(answer()).toBe("true"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resolves false on Cancel", async () => {
    const { dialog, answer } = await ask();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(answer()).toBe("false"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resolves false on Escape", async () => {
    const { answer } = await ask();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(answer()).toBe("false"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resolves false on the X of the dialog", async () => {
    const { dialog, answer } = await ask();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(answer()).toBe("false"));
  });

  it("puts the danger variant on the confirm button, never the primary one", async () => {
    const { dialog } = await ask({
      title: "Delete “PRG1 2026” permanently?",
      confirmLabel: "Delete permanently",
      cancelLabel: "Keep it",
      danger: true,
    });
    const confirmButton = within(dialog).getByRole("button", { name: "Delete permanently" });
    expect(confirmButton).toHaveClass("bg-danger");
    expect(confirmButton).not.toHaveClass("bg-accent");
    expect(within(dialog).getByRole("button", { name: "Keep it" })).toBeInTheDocument();
  });

  it("defaults the labels to Confirm and Cancel", async () => {
    const { dialog } = await ask({ title: "Sure?" });
    expect(within(dialog).getByRole("button", { name: "Confirm" })).toHaveClass("bg-accent");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("focuses the confirm button, so Enter answers the question", async () => {
    const { dialog } = await ask();
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Archive classroom" }),
    );
  });

  it("keeps one dialog on screen even when two callers ask at once", async () => {
    renderWithProviders(
      <>
        <ConfirmHarness options={archive} label="First" />
        <ConfirmHarness options={{ title: "Second question?" }} label="Second" />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "First" }));
    await userEvent.click(screen.getByRole("button", { name: "Second" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Second question?");
  });
});
