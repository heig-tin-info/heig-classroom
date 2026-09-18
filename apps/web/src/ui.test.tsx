import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "./api";
import { renderWithProviders } from "./test/render";
import {
  Alert,
  Button,
  EmptyState,
  Field,
  Menu,
  Modal,
  QueryError,
  Segmented,
  Select,
  Sheet,
  Switch,
  Tabs,
  Tip,
  type MenuItem,
} from "./ui";

/*
 * The behaviour of the primitives, not their pixels: what a keyboard reaches,
 * what a screen reader is told, what a click ends up calling. `buttonClass`,
 * `menuPosition` and `scrollEdges` keep their pure tests in ui.test.ts.
 */

describe("Button", () => {
  it("renders its label and the variant chrome", () => {
    renderWithProviders(
      <>
        <Button>Create classroom</Button>
        <Button variant="danger">Delete</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Create classroom" })).toHaveClass("bg-accent");
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("bg-danger");
  });

  it("loading disables the button and shows the spinner", async () => {
    const onClick = vi.fn();
    renderWithProviders(
      <Button loading onClick={onClick}>
        Publish
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Publish" });
    expect(button).toBeDisabled();
    expect(button.querySelector("svg.animate-spin")).not.toBeNull();
    await userEvent.click(button).catch(() => {
      // user-event refuses to click a disabled control; that is the point.
    });
    expect(onClick).not.toHaveBeenCalled();
  });

  it("defaults to type=button, so a button in a form never submits it", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    renderWithProviders(
      <form onSubmit={onSubmit}>
        <Button>Add</Button>
      </form>,
    );
    const button = screen.getByRole("button", { name: "Add" });
    expect(button).toHaveAttribute("type", "button");
    await userEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("lets the caller ask for a submit button", () => {
    renderWithProviders(<Button type="submit">Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "submit");
  });
});

/** Opens a layer from a real button, so the focus has somewhere to come back to. */
function LayerHarness({
  render: renderLayer,
}: {
  render: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open ? renderLayer(() => setOpen(false)) : null}
    </>
  );
}

describe("Modal", () => {
  const openModal = async (onClose = vi.fn()) => {
    renderWithProviders(
      <LayerHarness
        render={(close) => (
          <Modal
            title="Archive PRG1 2026?"
            onClose={() => {
              onClose();
              close();
            }}
            footer={
              <>
                <Button variant="ghost">Cancel</Button>
                <Button>Archive</Button>
              </>
            }
          >
            The classroom disappears until you restore it.
          </Modal>
        )}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    return { dialog: screen.getByRole("dialog"), onClose };
  };

  it("renders in a portal, named by its own title", async () => {
    const { dialog } = await openModal();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Archive PRG1 2026?");
    // Portal: the panel is a child of <body>, not of the render container.
    expect(dialog.closest("[data-testid='container']")).toBeNull();
    expect(dialog.parentElement?.parentElement).toBe(document.body);
  });

  it("closes on Escape", async () => {
    const { onClose } = await openModal();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on a backdrop click (a stray click must not discard a form)", async () => {
    const { dialog, onClose } = await openModal();
    const backdrop = dialog.parentElement!;
    await userEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves the focus inside on open and back to the opener on close", async () => {
    const { dialog } = await openModal();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" })),
    );
  });

  it("cycles the Tab order inside the panel", async () => {
    const { dialog } = await openModal();
    const stops = [
      within(dialog).getByRole("button", { name: "Close" }),
      within(dialog).getByRole("button", { name: "Cancel" }),
      within(dialog).getByRole("button", { name: "Archive" }),
    ];
    const last = stops[2]!;
    const first = stops[0]!;
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe("Sheet", () => {
  const openSheet = async (onClose = vi.fn()) => {
    renderWithProviders(
      <LayerHarness
        render={(close) => (
          <Sheet
            title="New assignment"
            subtitle="Draft — nothing is published yet"
            onClose={() => {
              onClose();
              close();
            }}
            footer={<Button>Create assignment</Button>}
          >
            <label>
              Name
              <input />
            </label>
          </Sheet>
        )}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    return { dialog: screen.getByRole("dialog"), onClose };
  };

  it("is a named modal dialog in a portal, with its footer", async () => {
    const { dialog } = await openSheet();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("New assignment");
    expect(within(dialog).getByText("Draft — nothing is published yet")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create assignment" })).toBeInTheDocument();
    expect(dialog.parentElement?.parentElement).toBe(document.body);
  });

  it("closes on Escape and hands the focus back to the opener", async () => {
    const { dialog, onClose } = await openSheet();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" })),
    );
  });

  it("closes on its X button", async () => {
    const { dialog, onClose } = await openSheet();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside the panel", async () => {
    const { dialog } = await openSheet();
    const close = within(dialog).getByRole("button", { name: "Close" });
    const create = within(dialog).getByRole("button", { name: "Create assignment" });
    create.focus();
    fireEvent.keyDown(create, { key: "Tab" });
    expect(document.activeElement).toBe(close);
  });
});

describe("Menu", () => {
  const items = (onSelect: () => void): MenuItem[] => [
    { label: "Clone script", onSelect },
    { label: "Export", disabled: true },
    { label: "Documentation", href: "https://example.org/docs" },
    { label: "Delete", danger: true, separator: true, onSelect: () => {} },
  ];

  const renderMenu = (onSelect = vi.fn()) => {
    renderWithProviders(<Menu label="Assignment actions" items={items(onSelect)} />);
    return { trigger: screen.getByRole("button", { name: "Assignment actions" }), onSelect };
  };

  it("announces itself as a menu button and opens on click", async () => {
    const { trigger } = renderMenu();
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Assignment actions" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(4);
  });

  it("opens on ArrowDown with the first item focused, and wraps with the arrows", async () => {
    const { trigger } = renderMenu();
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    const menu = screen.getByRole("menu");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Clone script" }));
    // "Export" is disabled: the arrows step over it.
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      within(menu).getByRole("menuitem", { name: "Documentation" }),
    );
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Delete" }));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      within(menu).getByRole("menuitem", { name: "Clone script" }),
    );
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Delete" }));
  });

  it("opens on ArrowUp with the last item focused", async () => {
    const { trigger } = renderMenu();
    trigger.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "Delete" }),
    );
  });

  it("selects with Enter, then closes and restores the focus", async () => {
    const { trigger, onSelect } = renderMenu();
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape and restores the focus", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on an outside click", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renders an href item as a link and a disabled item as disabled", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    const menu = screen.getByRole("menu");
    const link = within(menu).getByRole("menuitem", { name: "Documentation" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "https://example.org/docs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(within(menu).getByRole("menuitem", { name: "Export" })).toBeDisabled();
  });
});

type DemoTab = "assignments" | "students" | "staff";

function TabsHarness({ onChange }: { onChange: (v: DemoTab) => void }) {
  const [value, setValue] = useState<DemoTab>("assignments");
  return (
    <Tabs
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
      idPrefix="classroom"
      label="Classroom sections"
      items={[
        { value: "assignments", label: "Assignments" },
        { value: "students", label: "Students", count: 24 },
        { value: "staff", label: "Staff" },
      ]}
    />
  );
}

describe("Tabs", () => {
  it("keeps one tab in the Tab order (roving tabindex)", () => {
    renderWithProviders(<TabsHarness onChange={vi.fn()} />);
    expect(screen.getByRole("tab", { name: /Assignments/ })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: /Students/ })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tab", { name: /Assignments/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("selects the next tab on ArrowRight and wraps on the last one", async () => {
    const onChange = vi.fn();
    renderWithProviders(<TabsHarness onChange={onChange} />);
    const tablist = screen.getByRole("tablist", { name: "Classroom sections" });
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("students");
    expect(screen.getByRole("tab", { name: /Students/ })).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Students/ }));
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("assignments");
  });

  it("jumps to the ends with Home and End", () => {
    const onChange = vi.fn();
    renderWithProviders(<TabsHarness onChange={onChange} />);
    const tablist = screen.getByRole("tablist", { name: "Classroom sections" });
    fireEvent.keyDown(tablist, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("staff");
    fireEvent.keyDown(tablist, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("assignments");
  });

  it("wires every tab to its panel through idPrefix", () => {
    renderWithProviders(<TabsHarness onChange={vi.fn()} />);
    const tab = screen.getByRole("tab", { name: /Students/ });
    expect(tab).toHaveAttribute("id", "classroom-tab-students");
    expect(tab).toHaveAttribute("aria-controls", "classroom-panel-students");
  });
});

describe("Segmented", () => {
  it("is a radiogroup of real radios and reports the change", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <Segmented
        name="classrooms-view"
        value="cards"
        onChange={onChange}
        options={[
          { value: "cards", label: "Card view" },
          { value: "list", label: "List view" },
        ]}
      />,
    );
    const group = screen.getByRole("radiogroup");
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByRole("radio", { name: "Card view" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "List view" }));
    expect(onChange).toHaveBeenCalledWith("list");
  });
});

function SwitchHarness({ onChange }: { onChange: (v: boolean) => void }) {
  const [on, setOn] = useState(false);
  return (
    <Switch
      label="E-mail notifications"
      checked={on}
      onChange={(v) => {
        setOn(v);
        onChange(v);
      }}
    />
  );
}

describe("Switch", () => {
  it("exposes its state and toggles on click", async () => {
    const onChange = vi.fn();
    renderWithProviders(<SwitchHarness onChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: "E-mail notifications" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});

describe("Field and Select", () => {
  it("binds the label to the control and types into it", async () => {
    renderWithProviders(<Field label="Classroom name" defaultValue="" />);
    const input = screen.getByLabelText("Classroom name");
    await userEvent.type(input, "PRG1");
    expect(input).toHaveValue("PRG1");
  });

  it("puts the height on the control and the width on the wrapper", () => {
    renderWithProviders(
      <>
        <Field label="Default" />
        <Field label="Dense" size="sm" width="w-32" />
        <Field label="Stretched" fullWidth />
      </>,
    );
    const byLabel = (label: string) => screen.getByLabelText(label);
    expect(byLabel("Default")).toHaveClass("h-8.5");
    expect(byLabel("Default").closest("label")).toHaveClass("w-52");
    expect(byLabel("Dense")).toHaveClass("h-7");
    expect(byLabel("Dense").closest("label")).toHaveClass("w-32");
    expect(byLabel("Stretched").closest("label")).toHaveClass("w-full");
  });

  it("labels a Select and carries its width on the control wrapper", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <Select label="GitHub organization" width="w-40" value="" onChange={onChange}>
        <option value="">Pick an organization</option>
        <option value="heig-prg1-2026">heig-prg1-2026</option>
      </Select>,
    );
    const select = screen.getByLabelText("GitHub organization");
    expect(select.parentElement).toHaveClass("w-40");
    expect(select).toHaveClass("h-8.5");
    await userEvent.selectOptions(select, "heig-prg1-2026");
    expect(onChange).toHaveBeenCalled();
  });
});

describe("Alert", () => {
  it("renders its title, its body and its one action", async () => {
    const onClick = vi.fn();
    renderWithProviders(
      <Alert
        tone="warning"
        title="This organization is on the GitHub Free plan"
        action={<Button onClick={onClick}>Request the upgrade</Button>}
      >
        Private repositories get no branch protection.
      </Alert>,
    );
    const alert = screen.getByRole("status");
    expect(within(alert).getByText("This organization is on the GitHub Free plan")).toBeVisible();
    expect(within(alert).getByText(/no branch protection/)).toBeVisible();
    await userEvent.click(within(alert).getByRole("button", { name: "Request the upgrade" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("QueryError", () => {
  it("shows the server's own message and retries on demand", async () => {
    const onRetry = vi.fn();
    renderWithProviders(
      <QueryError
        title="Could not load your classrooms"
        error={new ApiError(503, { message: "GitHub is unavailable" })}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Could not load your classrooms")).toBeVisible();
    expect(screen.getByText("GitHub is unavailable")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("falls back when the failure carries no message", () => {
    renderWithProviders(<QueryError title="Could not load this classroom" error={new Error("x")} />);
    expect(screen.getByText("The server did not answer.")).toBeVisible();
    // No retry handler: no Retry button either.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("uses the caller's fallback (student surfaces pass a translated one)", () => {
    renderWithProviders(
      <QueryError
        title="Could not load your classrooms"
        error={new ApiError(500, null)}
        fallback="Le serveur n'a pas répondu."
      />,
    );
    expect(screen.getByText("Le serveur n'a pas répondu.")).toBeVisible();
  });

  it("disables Retry while the refetch is in flight", () => {
    renderWithProviders(
      <QueryError title="Could not load" error={new Error("x")} onRetry={vi.fn()} retrying />,
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  });
});

describe("EmptyState", () => {
  it("carries the one action of the surface", async () => {
    const onClick = vi.fn();
    const Icon = () => <svg aria-hidden />;
    renderWithProviders(
      <EmptyState
        icon={Icon}
        title="No classrooms"
        action={<Button onClick={onClick}>Create classroom</Button>}
      >
        Create your first classroom to distribute assignments.
      </EmptyState>,
    );
    expect(screen.getByText("No classrooms")).toBeVisible();
    expect(screen.getByText(/distribute assignments/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Create classroom" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("Tip", () => {
  it("appears after the delay on hover and leaves on Escape", () => {
    vi.useFakeTimers();
    renderWithProviders(
      <Tip label="Lock repository (block pushes)">
        <button type="button">Lock</button>
      </Tip>,
    );
    const anchor = screen.getByRole("button", { name: "Lock" }).parentElement!;
    fireEvent.mouseEnter(anchor);
    // Nothing yet: the bubble waits 120 ms, so brushing past a row is silent.
    expect(screen.queryByText("Lock repository (block pushes)")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByText("Lock repository (block pushes)")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Lock repository (block pushes)")).toBeNull();
  });

  it("renders the child untouched when there is no label", () => {
    renderWithProviders(
      <Tip label={null}>
        <button type="button">Lock</button>
      </Tip>,
    );
    const button = screen.getByRole("button", { name: "Lock" });
    expect(button.parentElement).not.toHaveClass("inline-flex");
  });
});
