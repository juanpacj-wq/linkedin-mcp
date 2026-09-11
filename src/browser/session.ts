import { chromium, type BrowserContext, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { CONFIG, PATHS, LINKEDIN, ensureDirs } from "../config.js";
import { log, errorMessage } from "../logger.js";

let context: BrowserContext | null = null;
let launching: Promise<BrowserContext> | null = null;

/** Canales a intentar, en orden, hasta que uno abra. */
function channelCandidates(): (string | undefined)[] {
  const preferred = CONFIG.channel;
  const all = [preferred, "chrome", "msedge", undefined];
  return [...new Set(all)];
}

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-default-browser-check",
  "--no-first-run",
  "--disable-features=Translate,OptimizationHints",
  "--start-maximized",
];

async function launch(): Promise<BrowserContext> {
  ensureDirs();
  let lastError: unknown;

  for (const channel of channelCandidates()) {
    try {
      const ctx = await chromium.launchPersistentContext(PATHS.browserProfile, {
        headless: CONFIG.headless,
        ...(channel ? { channel } : {}),
        args: LAUNCH_ARGS,
        viewport: null,
        locale: CONFIG.locale,
        timezoneId: CONFIG.timezone,
        acceptDownloads: true,
        ignoreDefaultArgs: ["--enable-automation"],
      });

      ctx.setDefaultTimeout(CONFIG.actionTimeout);
      ctx.setDefaultNavigationTimeout(CONFIG.navTimeout);

      // Oculta el marcador más obvio de automatización.
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });

      ctx.on("close", () => {
        context = null;
        launching = null;
      });

      log.info("navegador abierto", { channel: channel ?? "chromium-bundled" });
      return ctx;
    } catch (err) {
      lastError = err;
      log.warn(`no se pudo abrir el canal "${channel ?? "chromium"}"`, errorMessage(err));
    }
  }

  throw new Error(
    `No se pudo abrir ningún navegador. Instala los binarios de Playwright con ` +
      `"npx playwright install chromium" o define LINKEDIN_PILOT_CHANNEL=msedge. ` +
      `Último error: ${errorMessage(lastError)}`,
  );
}

export async function getContext(): Promise<BrowserContext> {
  if (context) return context;
  if (!launching) {
    launching = launch().then(
      (ctx) => {
        context = ctx;
        launching = null;
        return ctx;
      },
      (err) => {
        launching = null;
        throw err;
      },
    );
  }
  return launching;
}

/** Devuelve la pestaña activa, creándola si hace falta. */
export async function getPage(): Promise<Page> {
  const ctx = await getContext();
  const pages = ctx.pages().filter((p) => !p.isClosed());
  const existing = pages[0];
  if (existing) return existing;
  return ctx.newPage();
}

export async function closeBrowser(): Promise<void> {
  if (context) {
    await context.close().catch(() => undefined);
    context = null;
  }
}

/* ------------------------------------------------------------------ */
/* Sesión                                                              */
/* ------------------------------------------------------------------ */

export interface SessionStatus {
  loggedIn: boolean;
  memberId?: string;
  vanityUrl?: string;
  displayName?: string;
  cookieExpiresAt?: string;
  reason?: string;
}

async function readCookie(name: string): Promise<string | undefined> {
  const ctx = await getContext();
  const cookies = await ctx.cookies(LINKEDIN.base);
  return cookies.find((c) => c.name === name)?.value;
}

/**
 * Token CSRF que exige Voyager: el JSESSIONID sin comillas.
 *
 * LinkedIn no entrega esa cookie al restaurar el perfil del navegador, sino al
 * cargar una de sus páginas. Si falta, se calienta la sesión en una pestaña
 * aparte para no interrumpir lo que esté abierto en la principal.
 */
export async function getCsrfToken(): Promise<string> {
  let raw = await readCookie("JSESSIONID");

  if (!raw) {
    const ctx = await getContext();
    const warmup = await ctx.newPage();
    try {
      await warmup.goto(LINKEDIN.feed, { waitUntil: "domcontentloaded" });
      await warmup.waitForTimeout(1_200);
    } catch (err) {
      log.warn("no se pudo calentar la sesión para obtener el CSRF", errorMessage(err));
    } finally {
      await warmup.close().catch(() => undefined);
    }
    raw = await readCookie("JSESSIONID");
  }

  if (!raw) {
    throw new Error(
      "LinkedIn no entregó la cookie JSESSIONID, así que su API interna no está disponible. " +
        "Las demás herramientas siguen funcionando: trabajan sobre la interfaz, no sobre esa API.",
    );
  }
  return raw.replace(/"/g, "");
}

/**
 * La verdad sobre la sesión es si el navegador puede abrir el feed sin que
 * LinkedIn lo mande al login. Voyager (su API interna) solo se usa después,
 * para poner nombre a la sesión, y que falle no significa que esté caída.
 */
export async function sessionStatus(): Promise<SessionStatus> {
  const ctx = await getContext();
  const cookies = await ctx.cookies(LINKEDIN.base);
  const liAt = cookies.find((c) => c.name === "li_at");

  if (!liAt) {
    return { loggedIn: false, reason: "No existe la cookie li_at (sesión no iniciada)." };
  }

  const expiresAt =
    liAt.expires && liAt.expires > 0 ? new Date(liAt.expires * 1000).toISOString() : undefined;
  const withExpiry = expiresAt ? { cookieExpiresAt: expiresAt } : {};

  const page = await getPage();
  try {
    await page.goto(LINKEDIN.feed, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_500);
  } catch (err) {
    return {
      loggedIn: false,
      reason: `No se pudo cargar LinkedIn: ${errorMessage(err)}`,
      ...withExpiry,
    };
  }

  const url = page.url();

  if (/\/(login|uas\/login|signup)/.test(url)) {
    return {
      loggedIn: false,
      reason: "LinkedIn redirigió a la pantalla de inicio de sesión: la sesión caducó.",
      ...withExpiry,
    };
  }

  if (/\/checkpoint/.test(url)) {
    return {
      loggedIn: false,
      reason:
        "LinkedIn pide una verificación adicional (código, captcha o confirmación de identidad). " +
        "Ejecuta `linkedin_login` y complétala en la ventana del navegador.",
      ...withExpiry,
    };
  }

  // A partir de aquí la sesión está viva. Lo demás es información extra.
  const identity = await identifyFromVoyager();
  if (identity) return { loggedIn: true, ...identity, ...withExpiry };

  const fromDom = await identifyFromPage(page);
  return { loggedIn: true, ...fromDom, ...withExpiry };
}

/** Nombre e identificador vía la API interna. Devuelve undefined si no responde. */
async function identifyFromVoyager(): Promise<Partial<SessionStatus> | undefined> {
  try {
    const ctx = await getContext();
    const token = await getCsrfToken();
    const res = await ctx.request.get(`${LINKEDIN.voyager}/me`, {
      headers: {
        "csrf-token": token,
        accept: "application/json",
        "x-restli-protocol-version": "2.0.0",
      },
      timeout: 20_000,
    });
    if (res.status() !== 200) return undefined;

    const body = (await res.json()) as {
      miniProfile?: {
        entityUrn?: string;
        publicIdentifier?: string;
        firstName?: string;
        lastName?: string;
      };
    };
    const mini = body.miniProfile;
    if (!mini) return undefined;

    const memberId = mini.entityUrn?.split(":").pop();
    const displayName = [mini.firstName, mini.lastName].filter(Boolean).join(" ");
    return {
      ...(memberId ? { memberId } : {}),
      ...(mini.publicIdentifier ? { vanityUrl: mini.publicIdentifier } : {}),
      ...(displayName ? { displayName } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Plan B: sacar el identificador público del enlace al perfil propio. */
async function identifyFromPage(page: Page): Promise<Partial<SessionStatus>> {
  try {
    const vanity = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]'));
      for (const a of links) {
        const match = a.href.match(/\/in\/([^/?#]+)/);
        if (match?.[1] && match[1] !== "me") return match[1];
      }
      return "";
    });
    return vanity ? { vanityUrl: vanity } : {};
  } catch {
    return {};
  }
}

export async function ensureLoggedIn(): Promise<SessionStatus> {
  const status = await sessionStatus();
  if (!status.loggedIn) {
    throw new Error(
      `Sesión de LinkedIn no iniciada. ${status.reason ?? ""}\n` +
        `Ejecuta la herramienta \`linkedin_login\` (abre el navegador para que inicies sesión a mano, ` +
        `incluida la verificación en dos pasos) y vuelve a intentar.`,
    );
  }
  return status;
}

/**
 * Abre la pantalla de inicio de sesión y espera hasta que el usuario complete
 * el proceso a mano (contraseña, 2FA, captcha). No automatizamos el login:
 * es lo que dispara los bloqueos y además obliga a guardar la contraseña.
 */
export async function interactiveLogin(timeoutMs = 300_000): Promise<SessionStatus> {
  const ctx = await getContext();
  const page = await getPage();

  const already = await sessionStatus();
  if (already.loggedIn) return already;

  await page.goto(`${LINKEDIN.base}/login`, { waitUntil: "domcontentloaded" });
  await page.bringToFront().catch(() => undefined);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    if (page.isClosed()) break;
    const cookies = await ctx.cookies(LINKEDIN.base);
    const liAt = cookies.find((c) => c.name === "li_at");
    const url = page.url();
    const stillOnAuth = /\/(login|uas\/login|checkpoint|signup)/.test(url);
    if (liAt && !stillOnAuth) {
      await page.waitForTimeout(1_500);
      const status = await sessionStatus();
      if (status.loggedIn) {
        log.info("sesión iniciada", { user: status.displayName });
        return status;
      }
    }
  }

  throw new Error(
    "Se agotó el tiempo esperando el inicio de sesión. Vuelve a ejecutar `linkedin_login` " +
      "y completa el proceso en la ventana del navegador que se abre.",
  );
}

/** Guarda una captura de pantalla y devuelve la ruta. */
export async function screenshot(name: string): Promise<string> {
  ensureDirs();
  const page = await getPage();
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
  const file = path.join(
    PATHS.screenshots,
    `${new Date().toISOString().replace(/[:.]/g, "-")}_${safe}.png`,
  );
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

/** Exporta las cookies de sesión (para respaldo o para otro cliente). */
export async function exportCookies(target?: string): Promise<string> {
  const ctx = await getContext();
  const cookies = await ctx.cookies(LINKEDIN.base);
  const dest = target ?? path.join(PATHS.home, "cookies-backup.json");
  fs.writeFileSync(dest, JSON.stringify(cookies, null, 2), "utf8");
  return dest;
}

/** Importa cookies (por ejemplo un li_at copiado del navegador personal). */
export async function importCookies(input: {
  liAt?: string;
  jsessionid?: string;
  cookiesJsonPath?: string;
}): Promise<void> {
  const ctx = await getContext();

  if (input.cookiesJsonPath) {
    const raw = JSON.parse(fs.readFileSync(input.cookiesJsonPath, "utf8"));
    await ctx.addCookies(raw);
    return;
  }

  const toAdd = [];
  if (input.liAt) {
    toAdd.push({
      name: "li_at",
      value: input.liAt,
      domain: ".www.linkedin.com",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "None" as const,
    });
  }
  if (input.jsessionid) {
    const value = input.jsessionid.startsWith('"')
      ? input.jsessionid
      : `"${input.jsessionid}"`;
    toAdd.push({
      name: "JSESSIONID",
      value,
      domain: ".www.linkedin.com",
      path: "/",
      secure: true,
      sameSite: "None" as const,
    });
  }
  if (toAdd.length === 0) {
    throw new Error("No se recibió ninguna cookie para importar.");
  }
  await ctx.addCookies(toAdd);
}
