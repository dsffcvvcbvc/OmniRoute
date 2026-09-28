// @vitest-environment jsdom
//
// R11-02. The provider panel gated the three request-shaping cards behind its
// OWN hand-rolled <section data-testid="provider-extras-unsupported">, while
// the three cards themselves refuse through the shared ProviderSectionRefusal.
// Two divergent visual languages stood, and the tested one reached no user.
//
// This pins the panel to the shared component. It is a component-level test,
// not a shallow "it rendered" check: the assertions below are the exact
// differences between the two renderings, so a revert to the inline <section>
// fails on two of them rather than passing by accident.
//
// `resolveAisixSurfaceSupport` is deliberately NOT mocked. The env var drives
// the real gate, and the reason is read back from the real domain table, so
// "the reason reaches the DOM" is a fact about the product and not an echo of
// a stub. The four panels ARE stubbed: they are other slices' components and
// this test is about the gate between them.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProviderExtraPanels from "../ProviderExtraPanels";
import { aisixUnsupportedRead } from "@/shared/utils/aisixEndpoints";

const TITLE = "Request shaping, tool interception and Claude Code aliases";

vi.mock("../ProviderPlaygroundPanel", () => ({
  default: ({ providerId }: { providerId: string }) => (
    <div data-testid="stub-playground" data-provider-id={providerId} />
  ),
}));
vi.mock("../ProviderParamFilterSection", () => ({
  default: () => <div data-testid="stub-param-filters" />,
}));
vi.mock("../ProviderInterceptionSection", () => ({
  default: () => <div data-testid="stub-interception" />,
}));
vi.mock("../ProviderCcAliasSection", () => ({
  default: () => <div data-testid="stub-cc-alias" />,
}));

// `has` returns false for every key, so `providerText` takes its English
// literal branch — the same branch this component has always taken, since
// `providerExtrasUnsupportedTitle` is not in the message catalogue.
vi.mock("next-intl", () => {
  const translate = Object.assign(
    (key: string) => key,
    { has: () => false, rich: () => key }
  );
  return { useTranslations: () => translate };
});

const cleanups: Array<() => void> = [];

function renderPanel() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ProviderExtraPanels providerId="openai" />));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

const previousExport = process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT;

beforeEach(() => {
  cleanups.length = 0;
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.innerHTML = "";
  if (previousExport === undefined) delete process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT;
  else process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT = previousExport;
});

describe("the provider panel refuses through the shared component", () => {
  it("renders the shared refusal, not a private one, when the gateway lacks the surfaces", () => {
    process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT = "1";
    const container = renderPanel();

    const refusal = container.querySelector<HTMLElement>('[data-testid="provider-extras-unsupported"]');
    expect(refusal, "the panel showed no refusal at all where three cards used to be").not.toBeNull();
    expect(refusal?.getAttribute("role")).toBe("status");

    // (1) STRUCTURE. ProviderSectionRefusal puts the card's <h2> OUTSIDE the
    // role="status" element and the reason inside it. The inline <section> this
    // replaces put the <h2> INSIDE the role="status" element. So the presence of
    // a heading under the refusal is exactly the reverted shape.
    expect(
      refusal?.querySelector("h2"),
      "the refusal still nests its own heading, which is the hand-rolled <section>, not " +
        "the shared component"
    ).toBeNull();

    // (2) VISUAL LANGUAGE. The shared component names the state with the `block`
    // glyph on an amber banner; the inline one used `cloud_off`. Unifying the
    // two languages IS the fix, so the glyph is the assertion that carries it.
    const glyph = refusal?.querySelector(".material-symbols-outlined");
    expect(glyph?.textContent?.trim()).toBe("block");
    expect(container.textContent).not.toContain("cloud_off");

    // The title survives the swap — it moves out of the status region rather
    // than disappearing, so the operator still learns WHICH capability is gone.
    const heading = container.querySelector("h2");
    expect(heading?.textContent?.trim()).toBe(TITLE);
  });

  it("carries the gateway's real refusal reason to the DOM", () => {
    process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT = "1";
    const container = renderPanel();

    // Read from the real domain table, not from a stub: this asserts that the
    // reason the AISIX gate produces is the reason an operator can actually
    // read, which is the whole point of stating a refusal at all.
    const reason = aisixUnsupportedRead("providerExtras").reason;
    const refusal = container.querySelector('[data-testid="provider-extras-unsupported"]');

    expect(refusal?.textContent).toContain(reason);
    // A refusal with no text is a blank region wearing a refusal's borders.
    expect((refusal?.textContent ?? "").replace(/^block/, "").trim().length).toBeGreaterThan(20);
  });

  it("mounts none of the three cards it is refusing, and still renders the playground", () => {
    process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT = "1";
    const container = renderPanel();

    // Refusing by not mounting is the panel's actual contract: nothing is
    // fetched, so no card can enter a 404-driven state machine.
    for (const id of ["stub-param-filters", "stub-interception", "stub-cc-alias"]) {
      expect(container.querySelector(`[data-testid="${id}"]`)).toBeNull();
    }
    // The playground is a different capability (model catalog) and is not gated.
    expect(container.querySelector('[data-testid="stub-playground"]')?.getAttribute("data-provider-id")).toBe(
      "openai"
    );
  });

  it("mounts the three cards and shows no refusal on a normal Next build", () => {
    process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT = "0";
    const container = renderPanel();

    for (const id of ["stub-param-filters", "stub-interception", "stub-cc-alias"]) {
      expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-testid="provider-extras-unsupported"]')).toBeNull();
  });
});
