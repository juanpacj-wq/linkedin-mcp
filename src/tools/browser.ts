import { getPage, screenshot } from "../browser/session.js";
import { describeForm, defaultScope } from "../browser/forms.js";
import { pause, humanScroll } from "../browser/humanize.js";

/**
 * Herramientas de bajo nivel. Son la vía de escape: si LinkedIn cambia y una
 * herramienta de alto nivel deja de encontrar un botón, desde aquí se puede
 * terminar el trabajo a mano sin tocar el código.
 */

export interface PageSnapshot {
  url: string;
  title: string;
  scope: string;
  headings: string[];
  links: { ref: string; text: string; href: string }[];
  buttons: { ref: string; label: string; disabled: boolean }[];
  fields: { ref: string; label: string; kind: string; required: boolean; value: string; options?: string[] }[];
  dialogOpen: boolean;
  errors: string[];
  visibleText: string;
}

export async function snapshotPage(scopeSelector?: string, textLimit = 4000): Promise<PageSnapshot> {
  const page = await getPage();
  const scope = scopeSelector ?? (await defaultScope(page));
  const form = await describeForm(page, scope);

  const extra = await page.evaluate(
    ({ rootSelector, limit }: { rootSelector: string; limit: number }) => {
      const matches = document.querySelectorAll(rootSelector);
      const root = (matches[matches.length - 1] ?? document.body) as HTMLElement;
      const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
      const isVisible = (el: Element) => (el as HTMLElement).getClientRects().length > 0;

      let counter = 10_000;
      const links: { ref: string; text: string; href: string }[] = [];
      for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
        if (!isVisible(a)) continue;
        const text = clean(a.getAttribute("aria-label") ?? a.textContent);
        if (!text) continue;
        const ref = `ln${++counter}`;
        a.setAttribute("data-lp-ref", ref);
        links.push({ ref, text: text.slice(0, 120), href: a.href });
        if (links.length >= 80) break;
      }

      const headings = Array.from(root.querySelectorAll("h1, h2, h3"))
        .filter(isVisible)
        .map((h) => clean(h.textContent))
        .filter(Boolean)
        .slice(0, 30);

      return {
        headings,
        links,
        visibleText: clean(root.innerText).slice(0, limit),
        dialogOpen: !!document.querySelector('div[role="dialog"]'),
      };
    },
    { rootSelector: scope, limit: textLimit },
  );

  return {
    url: page.url(),
    title: await page.title(),
    scope,
    headings: extra.headings,
    links: extra.links,
    buttons: form.buttons.map((b) => ({ ref: b.ref, label: b.label, disabled: b.disabled })),
    fields: form.fields.map((f) => ({
      ref: f.ref,
      label: f.label,
      kind: f.kind,
      required: f.required,
      value: f.value,
      ...(f.options ? { options: f.options } : {}),
    })),
    dialogOpen: extra.dialogOpen,
    errors: form.errors,
    visibleText: extra.visibleText,
  };
}

export async function navigate(url: string): Promise<PageSnapshot> {
  const page = await getPage();
  const target = url.startsWith("http") ? url : `https://www.linkedin.com${url.startsWith("/") ? "" : "/"}${url}`;
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await pause(page, 1_200, 2_400);
  return snapshotPage();
}

/** Hace clic por `ref` de un snapshot previo, o por texto visible. */
export async function clickElement(target: { ref?: string; text?: string }): Promise<PageSnapshot> {
  const page = await getPage();

  if (target.ref) {
    await page.locator(`[data-lp-ref="${target.ref}"]`).first().click({ timeout: 15_000 });
  } else if (target.text) {
    const byRole = page.getByRole("button", { name: new RegExp(target.text, "i") }).first();
    if (await byRole.count()) await byRole.click({ timeout: 15_000 });
    else await page.getByText(target.text, { exact: false }).first().click({ timeout: 15_000 });
  } else {
    throw new Error("Indica `ref` o `text`.");
  }

  await pause(page, 1_200, 2_400);
  return snapshotPage();
}

export async function typeInto(ref: string, text: string, submit = false): Promise<PageSnapshot> {
  const page = await getPage();
  const locator = page.locator(`[data-lp-ref="${ref}"]`).first();
  await locator.click({ timeout: 15_000 });
  const editable = await locator.evaluate((el) => (el as HTMLElement).isContentEditable);
  if (editable) {
    // ProseMirror: letra a letra se pasa del tiempo límite; se inserta de una vez.
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    await page.keyboard.insertText(text);
  } else {
    await locator.fill("");
    await locator.type(text, { delay: 25 });
  }
  if (submit) await locator.press("Enter");
  await pause(page, 900, 1_800);
  return snapshotPage();
}

export async function scrollPage(steps = 4): Promise<PageSnapshot> {
  const page = await getPage();
  await humanScroll(page, steps);
  return snapshotPage();
}

export async function capture(name = "manual"): Promise<{ path: string; url: string }> {
  // Sin comprobar la sesión: esa comprobación carga el feed y sacaría la
  // página del formulario o diálogo que se quiere fotografiar.
  const page = await getPage();
  const path = await screenshot(name);
  return { path, url: page.url() };
}
