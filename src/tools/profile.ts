import type { Page } from "playwright";
import { LINKEDIN } from "../config.js";
import { getPage, ensureLoggedIn, screenshot, sessionStatus } from "../browser/session.js";
import {
  clickButton,
  describeForm,
  fillForm,
  resolveFormRoot,
  type FormSnapshot,
} from "../browser/forms.js";
import { pause, humanScroll, retry } from "../browser/humanize.js";
import { getMe } from "../voyager/client.js";
import { readProfileViaVoyager } from "../voyager/profile.js";
import { saveProfileSnapshot, resolveDocument } from "../state/store.js";
import { log } from "../logger.js";

/* ------------------------------------------------------------------ */
/* Registro de secciones editables                                     */
/* ------------------------------------------------------------------ */

export interface SectionSpec {
  /** Ruta relativa al perfil propio que abre el editor. */
  path: string;
  /** Nombre humano de la sección. */
  title: string;
  /** Texto del botón que abre la sección desde el perfil, si el enlace falla. */
  fallbackButton?: RegExp;
  /** Campos típicos, para orientar a quien use la herramienta. */
  commonFields?: string[];
}

/**
 * Rutas de edición verificadas contra LinkedIn el 2026-09-01.
 *
 * Dos cosas cambiaron y rompían todo: los editores ya no son ventanas
 * modales sino páginas completas, y `/in/me/` no sirve para estas rutas (hay
 * que usar el identificador público real). Las rutas `add-edit/TIPO/` siguen
 * redirigiendo a la página nueva, así que se conservan donde funcionan.
 */
export const SECTIONS: Record<string, SectionSpec> = {
  intro: {
    path: "edit/topcard/",
    title: "Presentación (nombre, titular, ubicación, sector)",
    fallbackButton: /editar (presentación|introducción)|edit intro/i,
    commonFields: ["Nombre", "Apellidos", "Titular", "Sector", "País/Región", "Ciudad"],
  },
  about: {
    path: "add-edit/SUMMARY/",
    title: "Acerca de",
    fallbackButton: /editar (acerca de|extracto)|edit about/i,
    commonFields: ["Acerca de", "Información"],
  },
  experience: {
    path: "add-edit/POSITION/",
    title: "Experiencia",
    commonFields: [
      "Cargo laboral",
      "Organización",
      "Ubicación",
      "Tipo de ubicación",
      "Tipo de empleo",
      "Fecha de inicio",
      "Fecha de finalización",
      "Descripción",
    ],
  },
  education: {
    path: "add-edit/EDUCATION/",
    title: "Educación",
    commonFields: [
      "Centro educativo",
      "Título",
      "Disciplina académica",
      "Fecha de inicio",
      "Fecha de finalización",
      "Nota media",
      "Descripción",
    ],
  },
  skill: {
    path: "add-edit/SKILL_AND_ASSOCIATION/",
    title: "Aptitudes",
    commonFields: ["Aptitud"],
  },
  certification: {
    path: "add-edit/CERTIFICATION/",
    title: "Licencias y certificaciones",
    commonFields: [
      "Nombre",
      "Organización emisora",
      "Fecha de emisión",
      "Fecha de caducidad",
      "ID de la credencial",
      "URL de la credencial",
    ],
  },
  project: {
    path: "add-edit/PROJECT/",
    title: "Proyectos",
    commonFields: ["Nombre", "Fecha de inicio", "Fecha de finalización", "Descripción", "URL"],
  },
  language: {
    path: "add-edit/LANGUAGE/",
    title: "Idiomas",
    commonFields: ["Idioma", "Nivel de competencia"],
  },
  course: {
    path: "add-edit/COURSE/",
    title: "Cursos",
    commonFields: ["Nombre", "Número"],
  },
  honor: {
    path: "edit/forms/honor/new",
    title: "Premios y reconocimientos",
    commonFields: ["Título", "Entidad emisora", "Fecha de emisión", "Descripción"],
  },
  publication: {
    path: "add-edit/PUBLICATION/",
    title: "Publicaciones",
    commonFields: ["Título", "Editorial", "Fecha de publicación", "URL", "Descripción"],
  },
  organization: {
    path: "edit/forms/organization/new",
    title: "Organizaciones",
    commonFields: ["Nombre", "Puesto", "Fecha de inicio", "Fecha de finalización", "Descripción"],
  },
  patent: {
    path: "edit/forms/patent/new",
    title: "Patentes",
    commonFields: ["Título", "Número de patente", "Estado", "Descripción"],
  },
  contactInfo: {
    path: "add-edit/CONTACT_INFO/",
    title: "Información de contacto",
    commonFields: ["Perfil", "Sitio web", "Teléfono", "Dirección", "Correo electrónico", "Cumpleaños"],
  },
  openToWork: {
    path: "opportunities/job-opportunities/edit/",
    title: "Abierto a trabajar",
    commonFields: ["Cargos", "Ubicaciones", "Tipos de empleo", "Fecha de inicio", "Quién puede ver"],
  },
};

export type SectionKey = keyof typeof SECTIONS;

/* ------------------------------------------------------------------ */
/* Lectura del perfil                                                  */
/* ------------------------------------------------------------------ */

export interface ProfileData {
  url: string;
  name?: string;
  headline?: string;
  location?: string;
  about?: string;
  openToWork?: boolean;
  connections?: string;
  followers?: string;
  experience: { title?: string; company?: string; dates?: string; location?: string; description?: string }[];
  education: { school?: string; degree?: string; dates?: string }[];
  skills: string[];
  certifications: { name?: string; issuer?: string; date?: string }[];
  languages: { name?: string; level?: string }[];
}

async function scrapeProfilePage(page: Page): Promise<ProfileData> {
  return page.evaluate(() => {
    const clean = (s: string | null | undefined): string =>
      (s ?? "").replace(/\s+/g, " ").trim();

    /** LinkedIn duplica el texto para lectores de pantalla; nos quedamos con el visible. */
    const visibleText = (el: Element | null | undefined): string => {
      if (!el) return "";
      const hidden = el.querySelector('span[aria-hidden="true"]');
      if (hidden) return clean(hidden.textContent);
      const vis = el.querySelector(".visually-hidden");
      if (vis) return clean(vis.textContent);
      return clean(el.textContent);
    };

    const sectionByAnchor = (anchorId: string): Element | null => {
      const anchor = document.getElementById(anchorId);
      return anchor?.closest("section") ?? null;
    };

    const listItems = (section: Element | null): Element[] =>
      section
        ? Array.from(section.querySelectorAll("li.artdeco-list__item, li.pvs-list__paged-list-item"))
        : [];

    const topCard = document.querySelector("section.pv-top-card, main section:first-of-type");
    const name = visibleText(document.querySelector("h1"));
    const headline = clean(
      document.querySelector(".text-body-medium.break-words")?.textContent ??
        topCard?.querySelector(".text-body-medium")?.textContent,
    );
    const location = clean(
      document.querySelector(".text-body-small.inline.t-black--light.break-words")?.textContent,
    );

    const aboutSection = sectionByAnchor("about");
    const about = aboutSection
      ? clean(
          aboutSection.querySelector(
            '.display-flex.ph5.pv3 span[aria-hidden="true"], .inline-show-more-text span[aria-hidden="true"]',
          )?.textContent,
        )
      : "";

    const parseEntries = (anchorId: string) =>
      listItems(sectionByAnchor(anchorId)).map((li) => {
        const spans = Array.from(li.querySelectorAll('span[aria-hidden="true"]')).map((s) =>
          clean(s.textContent),
        );
        const unique: string[] = [];
        for (const s of spans) {
          if (s && !unique.includes(s)) unique.push(s);
        }
        return unique;
      });

    const experience = parseEntries("experience").map((parts) => ({
      title: parts[0] ?? "",
      company: parts[1] ?? "",
      dates: parts[2] ?? "",
      location: parts[3] ?? "",
      description: parts.slice(4).join(" · "),
    }));

    const education = parseEntries("education").map((parts) => ({
      school: parts[0] ?? "",
      degree: parts[1] ?? "",
      dates: parts[2] ?? "",
    }));

    const skills = parseEntries("skills")
      .map((parts) => parts[0] ?? "")
      .filter(Boolean);

    const certifications = parseEntries("licenses_and_certifications").map((parts) => ({
      name: parts[0] ?? "",
      issuer: parts[1] ?? "",
      date: parts[2] ?? "",
    }));

    const languages = parseEntries("languages").map((parts) => ({
      name: parts[0] ?? "",
      level: parts[1] ?? "",
    }));

    const bodyText = document.body.innerText;
    const connMatch = bodyText.match(/([\d.,]+)\s*(?:contactos|connections)/i);
    const followMatch = bodyText.match(/([\d.,]+)\s*(?:seguidores|followers)/i);

    return {
      url: location ? window.location.href : window.location.href,
      name,
      headline,
      location,
      about,
      openToWork: /#OPEN_TO_WORK|Abierto a trabajar|Open to work/i.test(bodyText),
      connections: connMatch?.[1] ?? "",
      followers: followMatch?.[1] ?? "",
      experience,
      education,
      skills,
      certifications,
      languages,
    };
  });
}

/** Identificador público a partir de "me", una URL o un slug. */
export async function resolveVanity(target?: string): Promise<string | undefined> {
  if (!target || target === "me" || target === "yo") {
    const me = await getMe();
    if (me.vanityUrl) return me.vanityUrl;
    // Plan B: el estado de sesión también lo averigua, incluso desde el DOM.
    const status = await sessionStatus();
    return status.vanityUrl;
  }
  if (target.startsWith("http")) {
    const slug = target.match(/\/in\/([^/?#]+)/)?.[1];
    return slug && slug !== "me" ? slug : undefined;
  }
  const clean = target.replace(/^\/?(in\/)?/, "").replace(/\/$/, "");
  return clean && clean !== "me" ? clean : undefined;
}

/**
 * Lee un perfil completo. Primero por la API interna, que devuelve los datos
 * estructurados en una sola llamada; si no responde, cae al raspado del HTML.
 *
 * El orden importa: desde que LinkedIn renderiza el perfil con SDUI, el HTML
 * ya no trae `<h1>` ni anclas de sección, y las secciones cargan de forma
 * diferida, así que raspar es el plan B y no el principal.
 */
export async function readProfile(target?: string): Promise<ProfileData> {
  await ensureLoggedIn();

  const vanity = await resolveVanity(target);
  if (vanity) {
    try {
      const viaApi = await readProfileViaVoyager(vanity);
      if (viaApi && (viaApi.name || viaApi.experience.length > 0)) {
        const data: ProfileData = {
          url: viaApi.url,
          ...(viaApi.name ? { name: viaApi.name } : {}),
          ...(viaApi.headline ? { headline: viaApi.headline } : {}),
          ...(viaApi.location ? { location: viaApi.location } : {}),
          ...(viaApi.about ? { about: viaApi.about } : {}),
          ...(viaApi.openToWork !== undefined ? { openToWork: viaApi.openToWork } : {}),
          experience: viaApi.experience,
          education: viaApi.education,
          skills: viaApi.skills,
          certifications: viaApi.certifications,
          languages: viaApi.languages,
        };
        if (!target || target === "me") saveProfileSnapshot(data);
        return data;
      }
    } catch (err) {
      log.warn("lectura por API falló, se raspa el HTML", String(err));
    }
  }

  const page = await getPage();
  const url = await resolveProfileUrl(target);
  await retry(() => page.goto(url, { waitUntil: "domcontentloaded" }), { label: "abrir perfil" });
  await pause(page, 2_000, 3_000);
  await humanScroll(page, 8);
  await pause(page, 1_000, 1_800);

  const data = await scrapeProfilePage(page);
  data.url = page.url();
  if (!target || target === "me") saveProfileSnapshot(data);
  return data;
}

/** Acepta: undefined/"me", una URL completa, o un identificador público. */
export async function resolveProfileUrl(target?: string): Promise<string> {
  if (!target || target === "me" || target === "yo") return `${LINKEDIN.base}/in/me/`;
  if (target.startsWith("http")) return target.split("?")[0] ?? target;
  const slug = target.replace(/^\/?(in\/)?/, "").replace(/\/$/, "");
  return `${LINKEDIN.base}/in/${slug}/`;
}

/* ------------------------------------------------------------------ */
/* Edición                                                             */
/* ------------------------------------------------------------------ */

/**
 * Ámbito donde vive el formulario abierto.
 *
 * LinkedIn pasó los editores de perfil de ventana modal a página completa, así
 * que hay que contemplar las dos formas: primero un diálogo si lo hay, luego
 * el `<form>` de la página, y como último recurso el contenido principal.
 */
async function formScope(page: Page): Promise<string> {
  const dialog = page.locator('div[role="dialog"]');
  if (await dialog.last().isVisible().catch(() => false)) return 'div[role="dialog"]';

  // El editor puede estar en una capa fuera de <main>: se localiza por su
  // botón Guardar en vez de asumir dónde lo puso LinkedIn.
  const root = await resolveFormRoot(page).catch(() => undefined);
  if (root) return root;

  return "main";
}

/** ¿Hay de verdad un formulario editable delante? */
async function formIsOpen(page: Page): Promise<{ open: boolean; scope: string; snapshot: FormSnapshot }> {
  const scope = await formScope(page);
  const snapshot = await describeForm(page, scope);
  const editable = snapshot.fields.filter((f) => !f.disabled);
  const hasSave = snapshot.buttons.some((b) => /^(guardar|save|aplicar|apply)$/i.test(b.label));
  return { open: editable.length > 0 && hasSave, scope, snapshot };
}

/**
 * Abre el editor de una sección y devuelve la radiografía del formulario.
 * No guarda nada: sirve para saber exactamente qué campos existen antes de
 * escribir, que es lo que hace que esto funcione aunque LinkedIn cambie.
 */
export async function openSectionEditor(section: SectionKey): Promise<FormSnapshot> {
  await ensureLoggedIn();
  const spec = SECTIONS[section];
  if (!spec) {
    throw new Error(
      `Sección desconocida: "${section}". Disponibles: ${Object.keys(SECTIONS).join(", ")}`,
    );
  }

  // Estas rutas exigen el identificador público real: con "/in/me/" LinkedIn
  // responde "esta página no existe".
  const vanity = (await resolveVanity()) ?? "me";
  const page = await getPage();
  const url = `${LINKEDIN.base}/in/${vanity}/${spec.path}`;

  await retry(() => page.goto(url, { waitUntil: "domcontentloaded" }), {
    label: `abrir editor de ${section}`,
  });
  await pause(page, 2_000, 3_200);

  let state = await formIsOpen(page);

  if (!state.open && spec.fallbackButton) {
    // Plan B: entrar por el perfil y pulsar el botón de la sección.
    await page.goto(`${LINKEDIN.base}/in/${vanity}/`, { waitUntil: "domcontentloaded" });
    await pause(page, 1_500, 2_400);
    if (await clickButton(page, spec.fallbackButton, "main")) {
      await pause(page, 1_500, 2_400);
      state = await formIsOpen(page);
    }
  }

  if (!state.open) {
    const shot = await screenshot(`editor-${section}-sin-formulario`);
    throw new Error(
      `No se abrió el formulario de "${spec.title}". LinkedIn pudo cambiar la ruta (${url}), ` +
        `o la sesión pidió verificación. Captura: ${shot}. ` +
        `Usa \`linkedin_browser_snapshot\` para ver la página y \`linkedin_browser_click\` para navegar a mano.`,
    );
  }

  return state.snapshot;
}

export interface SectionEditResult {
  section: string;
  saved: boolean;
  filled: { label: string; status: string; detail?: string }[];
  notFound: string[];
  missingRequired: { label: string; kind: string; options?: string[] }[];
  errors: string[];
  availableFields: { label: string; kind: string; required: boolean; options?: string[] }[];
  screenshot?: string;
}

/**
 * Rellena (y opcionalmente guarda) una sección del perfil.
 *
 * Con `save: false` deja el formulario abierto y relleno para revisarlo: es el
 * modo recomendado la primera vez que se toca una sección nueva.
 */
export async function editSection(
  section: SectionKey,
  values: Record<string, string>,
  options: { save?: boolean } = {},
): Promise<SectionEditResult> {
  const snapshot = await openSectionEditor(section);
  const page = await getPage();
  const scope = snapshot.scope;

  const { results, notFound, snapshot: after, missingRequired } = await fillForm(
    page,
    values,
    scope,
  );

  const base: SectionEditResult = {
    section: SECTIONS[section]?.title ?? section,
    saved: false,
    filled: results.map((r) => ({
      label: r.label,
      status: r.status,
      ...(r.detail ? { detail: r.detail } : {}),
    })),
    notFound,
    missingRequired: missingRequired.map((f) => ({
      label: f.label,
      kind: f.kind,
      ...(f.options ? { options: f.options } : {}),
    })),
    errors: after.errors,
    availableFields: snapshot.fields.map((f) => ({
      label: f.label,
      kind: f.kind,
      required: f.required,
      ...(f.options ? { options: f.options } : {}),
    })),
  };

  if (!options.save) return base;

  if (missingRequired.length > 0) {
    return {
      ...base,
      errors: [
        ...base.errors,
        `No se guardó: faltan campos obligatorios (${missingRequired.map((f) => f.label).join(", ")}).`,
      ],
    };
  }

  const urlAntes = page.url();
  const clicked = await clickButton(page, /^(guardar|save|aplicar|done|listo)$/i, scope);
  if (!clicked) {
    const shot = await screenshot(`guardar-${section}`);
    return { ...base, errors: [...base.errors, "No se encontró el botón Guardar."], screenshot: shot };
  }

  await pause(page, 2_500, 4_000);

  // Al guardar, LinkedIn cierra el formulario y vuelve al perfil. Si seguimos
  // en la misma página con el formulario delante, es que rechazó algo.
  const sigueAbierto = await formIsOpen(page);
  const cambioDeUrl = page.url() !== urlAntes;

  if (sigueAbierto.open && !cambioDeUrl) {
    const post = sigueAbierto.snapshot;
    const shot = await screenshot(`guardar-${section}-error`);
    return {
      ...base,
      errors: [
        ...post.errors,
        "El formulario sigue abierto tras pulsar Guardar; probablemente LinkedIn rechazó algún campo.",
      ],
      missingRequired: post.fields
        .filter((f) => f.required && !f.value)
        .map((f) => ({ label: f.label, kind: f.kind, ...(f.options ? { options: f.options } : {}) })),
      screenshot: shot,
    };
  }

  log.info("sección guardada", { section });
  return { ...base, saved: true };
}

/* ------------------------------------------------------------------ */
/* Atajos de alto nivel                                                */
/* ------------------------------------------------------------------ */

export async function updateHeadline(headline: string, save = true): Promise<SectionEditResult> {
  return editSection("intro", { Titular: headline }, { save });
}

export async function updateAbout(text: string, save = true): Promise<SectionEditResult> {
  return editSection("about", { "Acerca de": text }, { save });
}

/** Sube foto de perfil o portada. */
export async function uploadProfileImage(
  kind: "photo" | "banner",
  filePath: string,
): Promise<{ ok: boolean; detail: string; screenshot?: string }> {
  await ensureLoggedIn();
  const resolved = resolveDocument(filePath);
  if (!resolved) {
    return { ok: false, detail: `No existe el archivo: ${filePath}` };
  }

  const page = await getPage();
  await page.goto(`${LINKEDIN.base}/in/me/`, { waitUntil: "domcontentloaded" });
  await pause(page, 1_500, 2_500);

  const trigger =
    kind === "photo"
      ? page.getByRole("button", { name: /foto|photo/i }).first()
      : page.getByRole("button", { name: /portada|banner|fondo|cover/i }).first();

  await trigger.click({ timeout: 15_000 }).catch(() => undefined);
  await pause(page, 1_200, 2_000);

  const fileInput = page.locator('input[type="file"]').last();
  if (!(await fileInput.count())) {
    const shot = await screenshot(`subir-${kind}`);
    return {
      ok: false,
      detail: "No se encontró el campo de archivo. Revisa la captura y usa las herramientas de navegador.",
      screenshot: shot,
    };
  }

  await fileInput.setInputFiles(resolved);
  await pause(page, 2_500, 4_000);

  for (const label of [/^(guardar|save|aplicar|apply)$/i, /^(siguiente|next)$/i]) {
    await clickButton(page, label, 'div[role="dialog"]');
    await pause(page, 1_200, 2_200);
  }

  const shot = await screenshot(`subir-${kind}-final`);
  const open = await page
    .locator('div[role="dialog"]')
    .last()
    .isVisible()
    .catch(() => false);
  return {
    ok: !open,
    detail: open
      ? "El diálogo sigue abierto: puede faltar recortar la imagen o confirmar. Revisa la captura."
      : `Imagen de ${kind === "photo" ? "perfil" : "portada"} actualizada.`,
    screenshot: shot,
  };
}

/** Configura "Abierto a trabajar". */
export async function setOpenToWork(
  values: Record<string, string>,
  save = true,
): Promise<SectionEditResult> {
  return editSection("openToWork", values, { save });
}

/** Cambia la URL personalizada del perfil. */
export async function setCustomUrl(vanity: string): Promise<{ ok: boolean; detail: string }> {
  await ensureLoggedIn();
  const page = await getPage();
  await page.goto(`${LINKEDIN.base}/public-profile/settings`, { waitUntil: "domcontentloaded" });
  await pause(page, 1_500, 2_500);

  const edit = page.getByRole("button", { name: /editar|edit/i }).first();
  await edit.click({ timeout: 10_000 }).catch(() => undefined);
  await pause(page, 800, 1_500);

  const input = page.locator('input[id*="public-profile"], input[name*="vanity"]').first();
  if (!(await input.count())) {
    return { ok: false, detail: "No se encontró el campo de URL personalizada." };
  }
  await input.fill(vanity);
  await pause(page, 500, 1_000);
  const saved = await clickButton(page, /^(guardar|save)$/i);
  await pause(page, 1_500, 2_500);
  return {
    ok: saved,
    detail: saved
      ? `URL solicitada: linkedin.com/in/${vanity}`
      : "No se pudo pulsar Guardar.",
  };
}

/** Devuelve el identificador público del perfil propio. */
export async function myVanity(): Promise<string | undefined> {
  const me = await getMe();
  return me.vanityUrl;
}
