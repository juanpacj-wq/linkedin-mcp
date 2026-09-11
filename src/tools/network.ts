import type { Page } from "playwright";
import { LINKEDIN } from "../config.js";
import { getPage, ensureLoggedIn, screenshot } from "../browser/session.js";
import { clickButton } from "../browser/forms.js";
import { pause, humanScroll, retry, humanType } from "../browser/humanize.js";
import { resolveProfileUrl } from "./profile.js";
import { guardOutbound, commitOutbound } from "./guard.js";
import { recordUsage } from "../state/store.js";
import { log } from "../logger.js";

/* ------------------------------------------------------------------ */
/* Búsqueda de personas                                                */
/* ------------------------------------------------------------------ */

export interface PersonResult {
  name: string;
  headline: string;
  location: string;
  profileUrl: string;
  degree: string;
  connectable: boolean;
}

export interface PeopleSearchOptions {
  keywords: string;
  limit?: number;
  location?: string;
  currentCompany?: string;
  connectionDegree?: ("1" | "2" | "3")[];
  page?: number;
}

export async function searchPeople(opts: PeopleSearchOptions): Promise<PersonResult[]> {
  await ensureLoggedIn();
  const page = await getPage();

  const url = new URL(`${LINKEDIN.base}/search/results/people/`);
  url.searchParams.set("keywords", opts.keywords);
  if (opts.connectionDegree?.length) {
    url.searchParams.set("network", JSON.stringify(opts.connectionDegree).replace(/"/g, '"'));
  }
  if (opts.page && opts.page > 1) url.searchParams.set("page", String(opts.page));

  await retry(() => page.goto(url.toString(), { waitUntil: "domcontentloaded" }), {
    label: "buscar personas",
  });
  await pause(page, 1_500, 2_800);
  await humanScroll(page, 5);

  recordUsage("profileViews", 0);

  const results = await page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    const visible = (el: Element) => el.getClientRects().length > 0;

    // Los resultados ya no viven en contenedores con clases reconocibles: las
    // clases son hashes que cambian solos. Así que se parte de los enlaces a
    // perfiles y se sube hasta la fila que contiene a una sola persona.
    const enlaces = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]'),
    ).filter(visible);

    const perfiles = new Map<string, HTMLAnchorElement>();
    for (const a of enlaces) {
      const url = a.href.split("?")[0] ?? a.href;
      if (!/\/in\/[^/]+\/?$/.test(url)) continue;
      if (!perfiles.has(url)) perfiles.set(url, a);
    }

    const distintos = (root: Element): number => {
      const urls = new Set<string>();
      for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]'))) {
        urls.add(a.href.split("?")[0] ?? a.href);
      }
      return urls.size;
    };

    const salida: {
      name: string;
      headline: string;
      location: string;
      profileUrl: string;
      degree: string;
      connectable: boolean;
    }[] = [];

    for (const [profileUrl, ancla] of perfiles) {
      // Subimos mientras la fila siga hablando de una sola persona.
      let fila: Element = ancla as Element;
      let padre: Element | null = ancla.parentElement;
      while (padre && padre !== document.body && distintos(padre) <= 1) {
        fila = padre;
        padre = padre.parentElement;
      }

      // La fila puede quedar demasiado ceñida al enlace y perder el titular:
      // se sube un nivel más mientras siga tratando de una sola persona.
      const textoDe = (el: Element) =>
        (el as HTMLElement).innerText
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);

      let lineas = textoDe(fila);
      let subir: Element | null = fila.parentElement;
      while (lineas.length < 3 && subir && subir !== document.body && distintos(subir) <= 1) {
        fila = subir;
        lineas = textoDe(fila);
        subir = subir.parentElement;
      }
      if (lineas.length === 0) continue;

      // LinkedIn repite el nombre para lectores de pantalla.
      const vistas = new Set<string>();
      lineas = lineas.filter((l) => {
        if (vistas.has(l)) return false;
        vistas.add(l);
        return true;
      });

      const esGrado = (l: string) => /^[•·]?\s*\d\s*(º|°|er|do|to|st|nd|rd|th)\+?$/i.test(l);
      const esAccion = (l: string) =>
        /^(conectar|connect|seguir|follow|mensaje|message|más|more|ver perfil|view profile)$/i.test(l);
      const esRuido = (l: string) =>
        /^(estado|status|·|•)$/i.test(l) || /^\d+\s*(contactos|connections|seguidores|followers)/i.test(l);

      const utiles = lineas.filter((l) => !esGrado(l) && !esAccion(l) && !esRuido(l));
      const name = utiles[0] ?? lineas[0] ?? "";
      const resto = utiles.slice(1);
      const degree = lineas.find(esGrado)?.replace(/[^\dºa-z]/gi, "") ?? "";

      const botones = Array.from(fila.querySelectorAll("button")).map((b) =>
        clean(b.getAttribute("aria-label") ?? b.textContent),
      );

      salida.push({
        name,
        headline: resto[0] ?? "",
        location: resto[1] ?? "",
        profileUrl,
        degree,
        connectable: botones.some((b) => /conectar|connect/i.test(b)),
      });
    }

    return salida;
  });

  const seen = new Set<string>();
  const deduped = results.filter((r) => {
    if (seen.has(r.profileUrl)) return false;
    seen.add(r.profileUrl);
    return true;
  });

  return deduped.slice(0, opts.limit ?? 20);
}

/* ------------------------------------------------------------------ */
/* Acciones sobre un perfil                                            */
/* ------------------------------------------------------------------ */

async function openProfile(target: string): Promise<Page> {
  await ensureLoggedIn();
  const page = await getPage();
  const url = await resolveProfileUrl(target);
  await retry(() => page.goto(url, { waitUntil: "domcontentloaded" }), { label: "abrir perfil" });
  await pause(page, 1_500, 2_800);
  return page;
}

/** Busca un botón en la tarjeta superior, incluido el menú "Más". */
async function topCardAction(page: Page, pattern: RegExp): Promise<boolean> {
  const direct = page.getByRole("button", { name: pattern }).first();
  if ((await direct.count()) && (await direct.isVisible().catch(() => false))) {
    await direct.click();
    await pause(page, 900, 1_800);
    return true;
  }

  // Puede estar escondida bajo "Más".
  const more = page.getByRole("button", { name: /^(más|more)$/i }).first();
  if ((await more.count()) && (await more.isVisible().catch(() => false))) {
    await more.click();
    await pause(page, 700, 1_400);
    const inMenu = page.getByRole("menuitem", { name: pattern }).first();
    if (await inMenu.count()) {
      await inMenu.click();
      await pause(page, 900, 1_800);
      return true;
    }
    const asButton = page.getByRole("button", { name: pattern }).first();
    if ((await asButton.count()) && (await asButton.isVisible().catch(() => false))) {
      await asButton.click();
      await pause(page, 900, 1_800);
      return true;
    }
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  return false;
}

export interface ActionResult {
  ok: boolean;
  detail: string;
  target: string;
  screenshot?: string;
}

/** Envía invitación a conectar, con nota opcional. */
export async function sendInvitation(
  target: string,
  note?: string,
  confirm?: boolean,
): Promise<ActionResult> {
  guardOutbound("invitations", confirm, `invitación a ${target}${note ? " con nota" : ""}`);

  const page = await openProfile(target);
  const opened = await topCardAction(page, /^(conectar|connect)$/i);
  if (!opened) {
    const shot = await screenshot("invitacion-sin-boton");
    return {
      ok: false,
      target,
      detail:
        "No se encontró el botón Conectar. Puede que ya seas contacto, que el perfil solo permita seguir, " +
        "o que haya invitación pendiente.",
      screenshot: shot,
    };
  }

  if (note?.trim()) {
    const addNote = await clickButton(page, /añadir nota|agregar nota|add a note/i, 'div[role="dialog"]');
    if (addNote) {
      const textarea = page.locator('div[role="dialog"] textarea').first();
      if (await textarea.count()) {
        const trimmed = note.slice(0, 300);
        await humanType(textarea, trimmed);
        await pause(page, 600, 1_200);
      }
    }
  }

  const sent =
    (await clickButton(page, /^(enviar|enviar invitación|send|send invitation|send without a note|enviar sin nota)$/i, 'div[role="dialog"]')) ||
    (await clickButton(page, /enviar|send/i, 'div[role="dialog"]'));

  await pause(page, 1_500, 2_500);

  if (!sent) {
    const shot = await screenshot("invitacion-sin-enviar");
    return { ok: false, target, detail: "No se pudo pulsar Enviar en el diálogo.", screenshot: shot };
  }

  commitOutbound("invitations", { target, ...(note ? { detail: note.slice(0, 120) } : {}) });
  log.info("invitación enviada", { target });
  return { ok: true, target, detail: `Invitación enviada${note ? " con nota" : ""}.` };
}

/** Envía un mensaje directo. */
export async function sendMessage(
  target: string,
  text: string,
  confirm?: boolean,
): Promise<ActionResult> {
  guardOutbound("messages", confirm, `mensaje a ${target}`);

  const page = await openProfile(target);
  const opened = await topCardAction(page, /^(mensaje|message|enviar mensaje)$/i);
  if (!opened) {
    const shot = await screenshot("mensaje-sin-boton");
    return {
      ok: false,
      target,
      detail: "No se encontró el botón Mensaje (puede requerir ser contacto o tener InMail).",
      screenshot: shot,
    };
  }

  const composer = page
    .locator('div[role="textbox"], .msg-form__contenteditable [contenteditable="true"], div.msg-form__contenteditable')
    .first();
  await composer.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  if (!(await composer.count())) {
    const shot = await screenshot("mensaje-sin-composer");
    return { ok: false, target, detail: "No se encontró el cuadro de redacción.", screenshot: shot };
  }

  await composer.click();
  await composer.type(text, { delay: 18 });
  await pause(page, 800, 1_600);

  const sent = await clickButton(page, /^(enviar|send)$/i);
  await pause(page, 1_500, 2_500);

  if (!sent) {
    const shot = await screenshot("mensaje-sin-enviar");
    return { ok: false, target, detail: "No se pudo pulsar Enviar.", screenshot: shot };
  }

  commitOutbound("messages", { target, detail: text.slice(0, 120) });
  return { ok: true, target, detail: "Mensaje enviado." };
}

/** Sigue (o deja de seguir) un perfil. */
export async function toggleFollow(
  target: string,
  follow = true,
  confirm?: boolean,
): Promise<ActionResult> {
  guardOutbound("follows", confirm, `${follow ? "seguir" : "dejar de seguir"} a ${target}`);

  const page = await openProfile(target);
  const pattern = follow ? /^(seguir|follow)$/i : /^(dejar de seguir|following|siguiendo|unfollow)$/i;
  const done = await topCardAction(page, pattern);

  if (done && !follow) {
    await clickButton(page, /^(dejar de seguir|unfollow)$/i, 'div[role="dialog"]');
  }
  await pause(page, 1_000, 2_000);

  if (!done) {
    return {
      ok: false,
      target,
      detail: `No se encontró el botón "${follow ? "Seguir" : "Dejar de seguir"}".`,
    };
  }

  commitOutbound("follows", { target });
  return { ok: true, target, detail: follow ? "Ahora sigues el perfil." : "Dejaste de seguir el perfil." };
}

/** Valida aptitudes de otra persona. */
export async function endorseSkills(
  target: string,
  skills: string[],
  confirm?: boolean,
): Promise<ActionResult> {
  guardOutbound("endorsements", confirm, `validar aptitudes de ${target}`);

  const page = await openProfile(target);
  const url = (await resolveProfileUrl(target)).replace(/\/$/, "") + "/details/skills/";
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await pause(page, 1_500, 2_500);
  await humanScroll(page, 4);

  const endorsed: string[] = [];
  for (const skill of skills) {
    const row = page.locator("li").filter({ hasText: skill }).first();
    if (!(await row.count())) continue;
    const button = row.getByRole("button", { name: /validar|endorse/i }).first();
    if ((await button.count()) && (await button.isEnabled().catch(() => false))) {
      await button.click().catch(() => undefined);
      endorsed.push(skill);
      await pause(page, 1_200, 2_400);
    }
  }

  if (endorsed.length) commitOutbound("endorsements", { target, detail: endorsed.join(", ") });

  return {
    ok: endorsed.length > 0,
    target,
    detail: endorsed.length
      ? `Aptitudes validadas: ${endorsed.join(", ")}`
      : "No se pudo validar ninguna aptitud (revisa que existan en su perfil).",
  };
}

/* ------------------------------------------------------------------ */
/* Invitaciones pendientes                                             */
/* ------------------------------------------------------------------ */

export async function listPendingInvitations(
  direction: "received" | "sent" = "received",
): Promise<{ name: string; headline: string; profileUrl: string }[]> {
  await ensureLoggedIn();
  const page = await getPage();
  const url =
    direction === "sent"
      ? `${LINKEDIN.base}/mynetwork/invitation-manager/sent/`
      : `${LINKEDIN.base}/mynetwork/invitation-manager/`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await pause(page, 1_800, 3_000);
  await humanScroll(page, 3);

  return page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll("li"))
      .map((li) => {
        const link = li.querySelector<HTMLAnchorElement>('a[href*="/in/"]');
        if (!link) return null;
        const spans = Array.from(li.querySelectorAll("span, p"))
          .map((s) => clean(s.textContent))
          .filter(Boolean);
        const unique: string[] = [];
        for (const s of spans) if (!unique.includes(s)) unique.push(s);
        return {
          name: unique[0] ?? clean(link.textContent),
          headline: unique[1] ?? "",
          profileUrl: link.href.split("?")[0] ?? link.href,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  });
}

/** Acepta o ignora invitaciones recibidas. */
export async function respondToInvitation(
  personName: string,
  action: "accept" | "ignore",
  confirm?: boolean,
): Promise<ActionResult> {
  guardOutbound("invitationResponses", confirm, `${action === "accept" ? "aceptar" : "ignorar"} invitación de ${personName}`);

  await ensureLoggedIn();
  const page = await getPage();
  await page.goto(`${LINKEDIN.base}/mynetwork/invitation-manager/`, { waitUntil: "domcontentloaded" });
  await pause(page, 1_800, 3_000);

  const row = page.locator("li").filter({ hasText: personName }).first();
  if (!(await row.count())) {
    return { ok: false, target: personName, detail: "No se encontró esa invitación." };
  }

  const pattern = action === "accept" ? /aceptar|accept/i : /ignorar|ignore/i;
  const button = row.getByRole("button", { name: pattern }).first();
  if (!(await button.count())) {
    return { ok: false, target: personName, detail: "No se encontró el botón correspondiente." };
  }

  await button.click();
  await pause(page, 1_200, 2_200);
  commitOutbound("invitationResponses", { target: personName, detail: action });
  return {
    ok: true,
    target: personName,
    detail: action === "accept" ? "Invitación aceptada." : "Invitación ignorada.",
  };
}

/** Retira una invitación enviada. */
export async function withdrawInvitation(
  personName: string,
  confirm?: boolean,
): Promise<ActionResult> {
  guardOutbound("invitationResponses", confirm, `retirar invitación a ${personName}`);

  await ensureLoggedIn();
  const page = await getPage();
  await page.goto(`${LINKEDIN.base}/mynetwork/invitation-manager/sent/`, {
    waitUntil: "domcontentloaded",
  });
  await pause(page, 1_800, 3_000);

  const row = page.locator("li").filter({ hasText: personName }).first();
  if (!(await row.count())) {
    return { ok: false, target: personName, detail: "No se encontró esa invitación enviada." };
  }
  const button = row.getByRole("button", { name: /retirar|withdraw/i }).first();
  if (!(await button.count())) {
    return { ok: false, target: personName, detail: "No se encontró el botón Retirar." };
  }
  await button.click();
  await pause(page, 900, 1_600);
  await clickButton(page, /retirar|withdraw/i, 'div[role="dialog"]');
  await pause(page, 1_200, 2_000);

  commitOutbound("invitationResponses", { target: personName, detail: "retirada" });
  return { ok: true, target: personName, detail: "Invitación retirada." };
}
