import type { Locator, Page } from "playwright";
import { CONFIG } from "../config.js";

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Pausa con jitter entre acciones, para no parecer un reloj. */
export async function pause(page: Page, min = CONFIG.minDelay, max = CONFIG.maxDelay): Promise<void> {
  await page.waitForTimeout(randomInt(min, max));
}

/** Escribe con cadencia irregular, como una persona. */
export async function humanType(locator: Locator, text: string): Promise<void> {
  await locator.click({ timeout: CONFIG.actionTimeout });
  await locator.fill("");
  for (const chunk of text.split(/(\s+)/)) {
    if (!chunk) continue;
    await locator.type(chunk, { delay: randomInt(18, 55) });
    if (Math.random() < 0.12) {
      await locator.page().waitForTimeout(randomInt(120, 380));
    }
  }
}

/** Desplaza la página en pasos, como al leer. */
export async function humanScroll(page: Page, steps = 4): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, randomInt(280, 620));
    await page.waitForTimeout(randomInt(280, 900));
  }
}

/**
 * Ejecuta con reintentos: LinkedIn re-renderiza mucho y un nodo puede
 * desprenderse entre que se localiza y se usa.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  { attempts = 3, delayMs = 900, label = "acción" }: { attempts?: number; delayMs?: number; label?: string } = {},
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw new Error(
    `Falló ${label} tras ${attempts} intentos: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
