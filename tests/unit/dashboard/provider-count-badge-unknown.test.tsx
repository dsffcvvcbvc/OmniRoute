// @vitest-environment jsdom
//
// Regression guard: a provider count that was never answered must not be drawn
// as a number.
//
// The configured count comes from the admin plane. When that plane refuses, the
// count is UNKNOWN — and `unknown` and `0` are different facts: `0` asserts
// that the operator configured nothing on a gateway the page was not allowed to
// read. The dashboard used to make exactly that assertion, by hiding the whole
// catalog behind the refusal; the fix keeps the catalog and has to keep the
// number honest instead.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const { default: ProviderCountBadge } =
  await import("../../../src/app/(dashboard)/dashboard/providers/components/ProviderCountBadge");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(configured: number | null, total: number) {
  act(() => {
    root.render(<ProviderCountBadge configured={configured} total={total} />);
  });
  return container.textContent ?? "";
}

describe("ProviderCountBadge — an unanswered count is not a zero", () => {
  it("renders a real zero as 0, because that one WAS answered", () => {
    expect(render(0, 12)).toBe("0/12");
  });

  it("renders a real count as a number", () => {
    expect(render(7, 12)).toBe("7/12");
  });

  it("renders an unknown count as a dash, never as 0", () => {
    // The assertion that can fail: with `configured` treated as a number, this
    // string is "0/12" — the false claim the refusal does not support.
    expect(render(null, 12)).toBe("—/12");
    expect(render(null, 12)).not.toBe("0/12");
  });

  it("marks the unknown badge so it can be found and explained", () => {
    render(null, 12);
    const unknown = container.querySelector("[data-testid='provider-count-unknown']");
    expect(unknown).not.toBeNull();
    // A dash with no explanation is a mystery; the title is the sentence the
    // page is already showing in its banner.
    expect(unknown?.getAttribute("title")).toBe("aisixAdminKeyRequired");
  });

  it("renders nothing for an empty section, answered or not", () => {
    expect(render(0, 0)).toBe("");
    expect(render(null, 0)).toBe("");
  });
});
