import type { Locator, Page } from "playwright";
import { CONFIG } from "../config.js";
import { humanType, pause, retry } from "./humanize.js";
import { normalizeLabel, bestScore, containsPhrase } from "../text.js";

export type FieldKind =
  | "text"
  | "textarea"
  | "richtext"
  | "select"
  | "radio"
  | "checkbox"
  | "file"
  | "typeahead"
  | "date"
  | "number"
  | "unknown";

export interface FieldDescriptor {
  /** Identificador estable dentro de esta inspección: se usa para rellenar. */
  ref: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  disabled: boolean;
  value: string;
  /** Opciones disponibles (select, radio). */
  options?: string[];
  /** Mensaje de validación visible ahora mismo. */
  error?: string;
  /** Texto de ayuda cercano (límites de caracteres, formato esperado). */
  hint?: string;
  maxLength?: number;
}

export interface FormSnapshot {
  scope: string;
  title?: string;
  fields: FieldDescriptor[];
  buttons: { ref: string; label: string; disabled: boolean; primary: boolean }[];
  /** Texto de progreso del asistente, si lo hay ("Paso 2 de 4", "60% completado"). */
  progress?: string;
  errors: string[];
}

/**
 * Marca los controles del ámbito con `data-lp-ref` y devuelve su descripción.
 * Trabajar por etiqueta accesible (y no por clases CSS) es lo que hace que
 * esto sobreviva a los rediseños de LinkedIn.
 */
export async function describeForm(page: Page, scopeSelector?: string): Promise<FormSnapshot> {
  const scope = scopeSelector ?? (await defaultScope(page));

  const snapshot = await page.evaluate((rootSelector: string) => {
    // Si hay varios diálogos abiertos, el activo es el último, igual que en
    // clickButton. Tomar el primero rellenaría un formulario que ya no se ve.
    const matches = document.querySelectorAll(rootSelector);
    const root = (matches[matches.length - 1] ?? document.body) as HTMLElement;

    const isVisible = (el: Element): boolean => {
      const he = el as HTMLElement;
      if (!he.getClientRects().length) return false;
      const style = window.getComputedStyle(he);
      return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
    };

    const textOf = (el: Element | null | undefined): string =>
      (el?.textContent ?? "").replace(/\s+/g, " ").trim();

    const labelFor = (el: HTMLElement): string => {
      const aria = el.getAttribute("aria-label");
      if (aria?.trim()) return aria.trim();

      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const parts = labelledBy
          .split(/\s+/)
          .map((id) => textOf(document.getElementById(id)))
          .filter(Boolean);
        if (parts.length) return parts.join(" ");
      }

      if (el.id) {
        const escaped = (window as unknown as { CSS: typeof CSS }).CSS.escape(el.id);
        const explicit = document.querySelector(`label[for="${escaped}"]`);
        if (explicit) return textOf(explicit);
      }

      const wrapping = el.closest("label");
      if (wrapping) return textOf(wrapping);

      const fieldset = el.closest("fieldset");
      if (fieldset) {
        const legend = fieldset.querySelector("legend");
        if (legend) return textOf(legend);
      }

      const group = el.closest('[role="group"], [role="radiogroup"]');
      if (group) {
        const ga = group.getAttribute("aria-label");
        if (ga?.trim()) return ga.trim();
        const gl = group.getAttribute("aria-labelledby");
        if (gl) {
          const t = textOf(document.getElementById(gl));
          if (t) return t;
        }
      }

      // Último recurso: el bloque de texto inmediatamente anterior.
      let node: Element | null = el;
      for (let depth = 0; depth < 4 && node; depth++) {
        let sib = node.previousElementSibling;
        while (sib) {
          const t = textOf(sib);
          if (t && t.length < 300 && !sib.querySelector("input, select, textarea")) return t;
          sib = sib.previousElementSibling;
        }
        node = node.parentElement;
      }
      return "";
    };

    const errorNear = (el: HTMLElement): string => {
      const describedBy = el.getAttribute("aria-describedby");
      if (describedBy) {
        for (const id of describedBy.split(/\s+/)) {
          const node = document.getElementById(id);
          if (!node) continue;
          const t = textOf(node);
          const looksLikeError =
            node.getAttribute("role") === "alert" ||
            /error|required|obligator|inválid|invalid/i.test(node.className + " " + t);
          if (t && looksLikeError) return t;
        }
      }
      const container = el.closest("fieldset, .artdeco-text-input, [data-test-form-element], div");
      const alert = container?.querySelector('[role="alert"], .artdeco-inline-feedback--error');
      return alert && isVisible(alert) ? textOf(alert) : "";
    };

    const hintNear = (el: HTMLElement): string => {
      const describedBy = el.getAttribute("aria-describedby");
      if (!describedBy) return "";
      for (const id of describedBy.split(/\s+/)) {
        const node = document.getElementById(id);
        if (!node) continue;
        const t = textOf(node);
        if (t && node.getAttribute("role") !== "alert") return t;
      }
      return "";
    };

    let counter = 0;
    const nextRef = (): string => `lp${++counter}`;

    const fields: {
      ref: string;
      label: string;
      kind: string;
      required: boolean;
      disabled: boolean;
      value: string;
      options?: string[];
      error?: string;
      hint?: string;
      maxLength?: number;
    }[] = [];

    const seenRadioGroups = new Set<string>();

    const controls = Array.from(
      root.querySelectorAll<HTMLElement>(
        'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="textbox"]',
      ),
    );

    for (const el of controls) {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      if (type === "hidden") continue;
      if (tag === "input" && type === "file") {
        // Los file inputs suelen estar ocultos tras un botón: se incluyen igual.
      } else if (!isVisible(el)) {
        continue;
      }

      let kind = "unknown";
      let options: string[] | undefined;
      let value = "";
      let groupKey = "";

      if (tag === "select") {
        kind = "select";
        const sel = el as unknown as HTMLSelectElement;
        options = Array.from(sel.options).map((o) => o.text.trim());
        value = sel.selectedOptions[0]?.text.trim() ?? "";
      } else if (tag === "textarea") {
        kind = "textarea";
        value = (el as unknown as HTMLTextAreaElement).value;
      } else if (el.getAttribute("contenteditable") === "true" || el.getAttribute("role") === "textbox") {
        kind = "richtext";
        value = textOf(el);
      } else if (tag === "input") {
        const input = el as unknown as HTMLInputElement;
        if (type === "radio") {
          groupKey = input.name || labelFor(el);
          if (seenRadioGroups.has(groupKey)) continue;
          seenRadioGroups.add(groupKey);
          kind = "radio";
          const siblings = Array.from(
            root.querySelectorAll<HTMLInputElement>(
              `input[type="radio"]${input.name ? `[name="${(window as unknown as { CSS: typeof CSS }).CSS.escape(input.name)}"]` : ""}`,
            ),
          );
          options = siblings.map((r) => labelFor(r)).filter(Boolean);
          value = siblings.find((r) => r.checked) ? labelFor(siblings.find((r) => r.checked)!) : "";
        } else if (type === "checkbox") {
          kind = "checkbox";
          value = input.checked ? "true" : "false";
        } else if (type === "file") {
          kind = "file";
          value = input.files && input.files.length ? String(input.files[0]?.name ?? "") : "";
        } else if (type === "date" || type === "month") {
          kind = "date";
          value = input.value;
        } else if (type === "number") {
          kind = "number";
          value = input.value;
        } else if (el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list") {
          kind = "typeahead";
          value = input.value;
        } else {
          kind = "text";
          value = input.value;
        }
      } else if (el.getAttribute("role") === "combobox") {
        kind = "typeahead";
        value = textOf(el);
      }

      // Para radios, la etiqueta útil es la del grupo, no la de la opción.
      let label = "";
      if (kind === "radio") {
        const fieldset = el.closest("fieldset");
        const legend = fieldset?.querySelector("legend");
        label = legend ? textOf(legend) : labelFor(el);
      } else {
        label = labelFor(el);
      }

      const ref = nextRef();
      el.setAttribute("data-lp-ref", ref);

      const maxLengthAttr = el.getAttribute("maxlength");
      const requiredAttr =
        el.hasAttribute("required") ||
        el.getAttribute("aria-required") === "true" ||
        /\*/.test(label);

      fields.push({
        ref,
        label: label.replace(/\s+/g, " ").trim(),
        kind,
        required: requiredAttr,
        disabled: (el as HTMLInputElement).disabled === true || el.getAttribute("aria-disabled") === "true",
        value,
        ...(options && options.length ? { options } : {}),
        ...(errorNear(el) ? { error: errorNear(el) } : {}),
        ...(hintNear(el) ? { hint: hintNear(el) } : {}),
        ...(maxLengthAttr ? { maxLength: Number.parseInt(maxLengthAttr, 10) } : {}),
      });
    }

    // Botones del ámbito.
    const buttons: { ref: string; label: string; disabled: boolean; primary: boolean }[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"]'))) {
      if (!isVisible(el)) continue;
      const label = (el.getAttribute("aria-label") || textOf(el)).replace(/\s+/g, " ").trim();
      if (!label) continue;
      const ref = nextRef();
      el.setAttribute("data-lp-ref", ref);
      buttons.push({
        ref,
        label,
        disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true",
        primary: /artdeco-button--primary/.test(el.className),
      });
    }

    // Errores generales del formulario.
    const errors = Array.from(root.querySelectorAll('[role="alert"], .artdeco-inline-feedback--error'))
      .filter((n) => isVisible(n))
      .map((n) => textOf(n))
      .filter(Boolean);

    const heading = root.querySelector('h1, h2, [role="heading"]');
    const progressNode = Array.from(root.querySelectorAll("*")).find((n) =>
      /(paso|step)\s+\d+\s+(de|of)\s+\d+|\d+%/i.test(textOf(n)) && textOf(n).length < 60,
    );

    return {
      title: heading ? textOf(heading) : "",
      fields,
      buttons,
      progress: progressNode ? textOf(progressNode) : "",
      errors: Array.from(new Set(errors)),
    };
  }, scope);

  return {
    scope,
    ...(snapshot.title ? { title: snapshot.title } : {}),
    fields: snapshot.fields as FieldDescriptor[],
    buttons: snapshot.buttons,
    ...(snapshot.progress ? { progress: snapshot.progress } : {}),
    errors: snapshot.errors,
  };
}

/** Etiquetas de los botones que cierran un paso de formulario. */
const SUBMIT_LABELS_RX =
  /^(guardar|save|aplicar|apply|siguiente|next|continuar|continue|enviar|enviar solicitud|submit|submit application|revisar|review|listo|done)$/i;

/**
 * Localiza el contenedor del formulario que hay delante y lo marca.
 *
 * No se puede asumir dónde lo pone LinkedIn: los editores de perfil dejaron de
 * ser ventanas modales y ahora se pintan en una capa que ni siquiera cuelga de
 * `<main>`. En vez de perseguir esa estructura, se parte del botón que cierra
 * el formulario y se sube hasta el primer ancestro que agrupa varios campos.
 * Eso funcione donde funcione el formulario.
 */
export async function resolveFormRoot(page: Page): Promise<string | undefined> {
  // Se intenta primero con un umbral alto, para no quedarse con un grupo
  // pequeño (una fila de mes/año, por ejemplo) en un formulario grande. Si no
  // hay nada así, se baja: "Acerca de" es un único campo de texto.
  for (const minControls of [3, 1]) {
    const root = await findFormRoot(page, minControls);
    if (root) return root;
  }
  return undefined;
}

async function findFormRoot(page: Page, minControls: number): Promise<string | undefined> {
  const found = await page.evaluate(([rxSource, min]: [string, number]) => {
    const rx = new RegExp(rxSource, "i");
    for (const marked of Array.from(document.querySelectorAll("[data-lp-form-root]"))) {
      marked.removeAttribute("data-lp-form-root");
    }

    const visible = (el: Element): boolean => {
      const he = el as HTMLElement;
      if (!he.getClientRects().length) return false;
      const style = window.getComputedStyle(he);
      return style.visibility !== "hidden" && style.display !== "none";
    };

    const controlsIn = (root: Element): number =>
      Array.from(
        root.querySelectorAll(
          'input:not([type="hidden"]), textarea, select, [contenteditable="true"], [role="combobox"], [role="textbox"]',
        ),
      ).filter(visible).length;

    const label = (el: Element): string =>
      (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();

    const submits = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))
      .filter(visible)
      .filter((b) => rx.test(label(b)));

    for (const button of submits) {
      let node: Element | null = button.parentElement;
      while (node && node !== document.body) {
        if (controlsIn(node) >= min) {
          node.setAttribute("data-lp-form-root", "1");
          return true;
        }
        node = node.parentElement;
      }
    }
    return false;
  }, [SUBMIT_LABELS_RX.source, minControls] as [string, number]);

  return found ? "[data-lp-form-root]" : undefined;
}

/**
 * Ámbito por defecto: el modal si lo hay, si no el contenedor del formulario
 * detectado, y como último recurso el contenido principal.
 */
export async function defaultScope(page: Page): Promise<string> {
  const dialog = page.locator('div[role="dialog"]:visible').last();
  if (await dialog.count().then((c) => c > 0).catch(() => false)) {
    return 'div[role="dialog"]';
  }
  const formRoot = await resolveFormRoot(page).catch(() => undefined);
  if (formRoot) return formRoot;
  return "main";
}

function byRef(page: Page, ref: string): Locator {
  return page.locator(`[data-lp-ref="${ref}"]`);
}

/** Empareja una etiqueta pedida con los campos disponibles, en cualquier idioma. */
export function matchField(
  fields: FieldDescriptor[],
  wanted: string,
): FieldDescriptor | undefined {
  const target = normalizeLabel(wanted);
  if (!target) return undefined;

  // 1. Coincidencia literal: gana siempre sobre cualquier equivalencia.
  //    Con campos como "Nombre" y "Nombre de la empresa" juntos, es lo único
  //    que garantiza no escribir en el que no era.
  const exact = fields.find((f) => normalizeLabel(f.label) === target);
  if (exact) return exact;

  // 2. El campo con mayor parecido, considerando el glosario bilingüe.
  //    Se toma el máximo (no el primero que pase el umbral) para que la
  //    etiqueta más específica gane a una genérica que aparezca antes.
  let best: { field: FieldDescriptor; score: number } | undefined;
  for (const field of fields) {
    const score = bestScore(wanted, field.label);
    if (score >= 0.55 && (!best || score > best.score)) best = { field, score };
  }
  return best?.field;
}

/** Elige la opción más parecida dentro de una lista cerrada. */
export function matchOption(options: string[], wanted: string): string | undefined {
  const target = normalizeLabel(wanted);
  if (!target) return undefined;

  const exact = options.find((o) => normalizeLabel(o) === target);
  if (exact) return exact;

  const contains = options.find((o) => {
    const n = normalizeLabel(o);
    return containsPhrase(n, target) || containsPhrase(target, n);
  });
  if (contains) return contains;
  // Sí/No en cualquier idioma o forma.
  if (/^(si|yes|true|1)$/.test(target)) {
    const yes = options.find((o) => /^(s[ií]|yes)$/i.test(o.trim()));
    if (yes) return yes;
  }
  if (/^(no|false|0)$/.test(target)) {
    const no = options.find((o) => /^no$/i.test(o.trim()));
    if (no) return no;
  }

  // Último recurso: la opción con mayor parecido, si es lo bastante clara.
  let best: { option: string; score: number } | undefined;
  for (const option of options) {
    const score = bestScore(wanted, option);
    if (score >= 0.6 && (!best || score > best.score)) best = { option, score };
  }
  return best?.option;
}

export interface FillResult {
  ref: string;
  label: string;
  kind: FieldKind;
  status: "filled" | "unchanged" | "failed";
  detail?: string;
}

/** Rellena un campo concreto respetando su tipo. */
export async function fillField(
  page: Page,
  field: FieldDescriptor,
  rawValue: string,
): Promise<FillResult> {
  const locator = byRef(page, field.ref);
  const base = { ref: field.ref, label: field.label, kind: field.kind };

  try {
    switch (field.kind) {
      case "select": {
        const option = matchOption(field.options ?? [], rawValue);
        if (!option) {
          return {
            ...base,
            status: "failed",
            detail: `"${rawValue}" no está entre las opciones: ${(field.options ?? []).join(" | ")}`,
          };
        }
        await locator.selectOption({ label: option });
        break;
      }

      case "radio": {
        const option = matchOption(field.options ?? [], rawValue);
        if (!option) {
          return {
            ...base,
            status: "failed",
            detail: `"${rawValue}" no está entre las opciones: ${(field.options ?? []).join(" | ")}`,
          };
        }
        // La ruta fiable es marcar el radio por su nombre accesible; si no,
        // hacer clic sobre la etiqueta visible de la opción.
        const byRole = page.getByRole("radio", { name: option, exact: false }).first();
        if (await byRole.count()) {
          await byRole.check({ force: true });
        } else {
          await page.getByText(option, { exact: true }).first().click();
        }
        break;
      }

      case "checkbox": {
        const on = /^(si|sí|yes|true|1|on)$/i.test(rawValue.trim());
        if (on) await locator.check({ force: true });
        else await locator.uncheck({ force: true });
        break;
      }

      case "file": {
        await locator.setInputFiles(rawValue);
        await pause(page, 900, 1800);
        break;
      }

      case "typeahead": {
        await humanType(locator, rawValue);
        await page.waitForTimeout(1_200);
        const listbox = page.locator('[role="listbox"] [role="option"], .basic-typeahead__triggered-content [role="option"]');
        const count = await listbox.count().catch(() => 0);
        if (count > 0) {
          let chosen = 0;
          for (let i = 0; i < Math.min(count, 8); i++) {
            const text = (await listbox.nth(i).innerText().catch(() => "")) ?? "";
            if (normalizeLabel(text).includes(normalizeLabel(rawValue))) {
              chosen = i;
              break;
            }
          }
          await listbox.nth(chosen).click();
        } else {
          await locator.press("Enter").catch(() => undefined);
        }
        break;
      }

      case "richtext": {
        await locator.click();
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Delete");
        // Los editores ProseMirror (titular, Acerca de) procesan cada tecla con
        // lentitud: escribir letra a letra pasa el tiempo límite con textos largos.
        // insertText entra como un solo evento de entrada, igual que pegar.
        await page.keyboard.insertText(rawValue);
        break;
      }

      case "date":
      case "number":
      case "text":
      case "textarea":
      default: {
        const value =
          field.maxLength && rawValue.length > field.maxLength
            ? rawValue.slice(0, field.maxLength)
            : rawValue;
        await humanType(locator, value);
        break;
      }
    }

    await pause(page, 200, 600);
    return { ...base, status: "filled" };
  } catch (err) {
    return {
      ...base,
      status: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Rellena varios campos identificándolos por etiqueta. Devuelve qué se llenó,
 * qué no se encontró y qué campos obligatorios siguen vacíos.
 */
export async function fillForm(
  page: Page,
  values: Record<string, string>,
  scopeSelector?: string,
): Promise<{
  results: FillResult[];
  notFound: string[];
  snapshot: FormSnapshot;
  missingRequired: FieldDescriptor[];
}> {
  const snapshot = await describeForm(page, scopeSelector);
  const results: FillResult[] = [];
  const notFound: string[] = [];
  const used = new Set<string>();

  for (const [label, value] of Object.entries(values)) {
    // Se compara contra todos los campos libres a la vez: evaluarlos de uno en
    // uno haría ganar al primero que pase el umbral en vez de al más parecido.
    const field = matchField(
      snapshot.fields.filter((f) => !used.has(f.ref)),
      label,
    );

    if (!field) {
      notFound.push(label);
      continue;
    }
    used.add(field.ref);
    results.push(await fillField(page, field, value));
  }

  const after = await describeForm(page, snapshot.scope);
  const missingRequired = after.fields.filter(
    (f) => f.required && !f.disabled && (f.value === "" || f.value === "false") && f.kind !== "file",
  );

  return { results, notFound, snapshot: after, missingRequired };
}

/** Hace clic en un botón del ámbito por su texto. */
export async function clickButton(
  page: Page,
  labelPattern: string | RegExp,
  scopeSelector?: string,
): Promise<boolean> {
  const scope = scopeSelector ?? (await defaultScope(page));
  // Si el ámbito pedido no existe, se busca en toda la página. `describeForm`
  // hace lo mismo: si uno cae a `body` y el otro no, se leen los campos de un
  // formulario y luego no se encuentra su propio botón.
  const scoped = page.locator(scope);
  const root = (await scoped.count().catch(() => 0)) > 0 ? scoped.last() : page.locator("body");
  const rx =
    typeof labelPattern === "string"
      ? new RegExp(labelPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
      : labelPattern;

  const candidates = root.getByRole("button", { name: rx });
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const btn = candidates.nth(i);
    if ((await btn.isVisible().catch(() => false)) && (await btn.isEnabled().catch(() => false))) {
      await retry(() => btn.click({ timeout: CONFIG.actionTimeout }), { label: `clic en "${rx}"` });
      await pause(page);
      return true;
    }
  }
  return false;
}
