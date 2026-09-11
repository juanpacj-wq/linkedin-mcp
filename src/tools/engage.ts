import type { Page } from "playwright";
import { LINKEDIN } from "../config.js";
import { getPage, ensureLoggedIn, screenshot } from "../browser/session.js";
import { clickButton } from "../browser/forms.js";
import { pause, humanScroll, retry } from "../browser/humanize.js";
import { guardOutbound, commitOutbound } from "./guard.js";
import type { ActionResult } from "./network.js";

export interface FeedPost {
  author: string;
  authorHeadline: string;
  text: string;
  postUrl?: string;
  urn?: string;
  age?: string;
  reactions?: string;
  comments?: string;
}

/** Lee publicaciones: del feed, o del perfil indicado. */
export async function readPosts(
  source: "feed" | string = "feed",
  limit = 10,
): Promise<FeedPost[]> {
  await ensureLoggedIn();
  const page = await getPage();

  const url =
    source === "feed"
      ? LINKEDIN.feed
      : source.startsWith("http")
        ? source.replace(/\/$/, "") + "/recent-activity/all/"
        : `${LINKEDIN.base}/in/${source.replace(/^\/?(in\/)?/, "").replace(/\/$/, "")}/recent-activity/all/`;

  await retry(() => page.goto(url, { waitUntil: "domcontentloaded" }), { label: "abrir publicaciones" });
  await pause(page, 2_000, 3_200);
  await humanScroll(page, Math.min(10, Math.ceil(limit / 2) + 2));

  const posts = await page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    const containers = Array.from(
      document.querySelectorAll("div.feed-shared-update-v2, div[data-urn], div[data-id]"),
    );

    return containers
      .map((el) => {
        const urn =
          el.getAttribute("data-urn") ??
          el.getAttribute("data-id") ??
          undefined;
        const textNode = el.querySelector(
          ".update-components-text, .feed-shared-update-v2__description, .update-components-update-v2__commentary",
        );
        const text = clean(textNode?.textContent).slice(0, 1200);
        if (!text) return null;

        const authorNode = el.querySelector(
          ".update-components-actor__title span[aria-hidden='true'], .update-components-actor__name",
        );
        const headlineNode = el.querySelector(
          ".update-components-actor__description span[aria-hidden='true'], .update-components-actor__description",
        );
        const ageNode = el.querySelector(
          ".update-components-actor__sub-description span[aria-hidden='true']",
        );

        const socialCounts = clean(
          el.querySelector(".social-details-social-counts")?.textContent,
        );
        const reactionsMatch = socialCounts.match(/^([\d.,]+)/);
        const commentsMatch = socialCounts.match(/([\d.,]+)\s*(comentario|comment)/i);

        const activityId = urn?.match(/(\d{15,})/)?.[1];

        return {
          author: clean(authorNode?.textContent),
          authorHeadline: clean(headlineNode?.textContent),
          text,
          ...(urn ? { urn } : {}),
          ...(activityId
            ? { postUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/` }
            : {}),
          age: clean(ageNode?.textContent),
          reactions: reactionsMatch?.[1] ?? "",
          comments: commentsMatch?.[1] ?? "",
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
  });

  const seen = new Set<string>();
  return posts
    .filter((p) => {
      const key = p.urn ?? p.text.slice(0, 80);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

/** Localiza una publicación: por URL directa o buscándola en la página actual. */
async function focusPost(page: Page, postUrl: string): Promise<void> {
  if (postUrl.startsWith("http")) {
    await retry(() => page.goto(postUrl, { waitUntil: "domcontentloaded" }), {
      label: "abrir publicación",
    });
    await pause(page, 2_000, 3_200);
  }
}

const REACTIONS: Record<string, RegExp> = {
  like: /^(recomendar|me gusta|like)$/i,
  celebrate: /^(celebrar|celebrate)$/i,
  support: /^(apoyar|support)$/i,
  love: /^(me encanta|love)$/i,
  insightful: /^(interesante|insightful)$/i,
  funny: /^(divertido|me divierte|funny)$/i,
};

/** Reacciona a una publicación. */
export async function reactToPost(
  postUrl: string,
  reaction: keyof typeof REACTIONS = "like",
  confirm?: boolean,
): Promise<ActionResult> {
  guardOutbound("reactions", confirm, `reaccionar (${reaction}) a ${postUrl}`);

  await ensureLoggedIn();
  const page = await getPage();
  await focusPost(page, postUrl);

  const likeButton = page.getByRole("button", { name: REACTIONS.like! }).first();
  if (!(await likeButton.count())) {
    const shot = await screenshot("reaccion-sin-boton");
    return { ok: false, target: postUrl, detail: "No se encontró el botón de reacción.", screenshot: shot };
  }

  if (reaction === "like") {
    await likeButton.click();
  } else {
    // Mantener pulsado abre el selector de reacciones.
    const box = await likeButton.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(1_200);
    }
    const specific = page.getByRole("button", { name: REACTIONS[reaction]! }).first();
    if (await specific.count()) await specific.click();
    else await likeButton.click();
  }

  await pause(page, 1_200, 2_200);
  commitOutbound("reactions", { target: postUrl, detail: reaction });
  return { ok: true, target: postUrl, detail: `Reacción "${reaction}" registrada.` };
}

/** Comenta una publicación. */
export async function commentOnPost(
  postUrl: string,
  text: string,
  confirm?: boolean,
): Promise<ActionResult> {
  guardOutbound("comments", confirm, `comentar en ${postUrl}`);

  await ensureLoggedIn();
  const page = await getPage();
  await focusPost(page, postUrl);

  const commentButton = page.getByRole("button", { name: /^(comentar|comment)$/i }).first();
  if (await commentButton.count()) {
    await commentButton.click().catch(() => undefined);
    await pause(page, 900, 1_800);
  }

  const box = page
    .locator('div.comments-comment-box [contenteditable="true"], div[role="textbox"][contenteditable="true"]')
    .first();
  await box.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  if (!(await box.count())) {
    const shot = await screenshot("comentario-sin-caja");
    return { ok: false, target: postUrl, detail: "No se encontró el cuadro de comentario.", screenshot: shot };
  }

  await box.click();
  await box.type(text, { delay: 18 });
  await pause(page, 900, 1_800);

  const published = await clickButton(page, /^(publicar|comentar|post|submit)$/i);
  await pause(page, 1_500, 2_500);

  if (!published) {
    const shot = await screenshot("comentario-sin-publicar");
    return { ok: false, target: postUrl, detail: "No se pudo pulsar Publicar.", screenshot: shot };
  }

  commitOutbound("comments", { target: postUrl, detail: text.slice(0, 120) });
  return { ok: true, target: postUrl, detail: "Comentario publicado." };
}

/** Publica en el feed. */
export async function createPost(
  text: string,
  options: { visibility?: "anyone" | "connections"; imagePath?: string; confirm?: boolean } = {},
): Promise<ActionResult> {
  guardOutbound("posts", options.confirm, "publicar en el feed");

  await ensureLoggedIn();
  const page = await getPage();
  await page.goto(LINKEDIN.feed, { waitUntil: "domcontentloaded" });
  await pause(page, 2_000, 3_000);

  const starter = page
    .getByRole("button", { name: /empieza una publicación|crear una publicación|start a post/i })
    .first();
  if (!(await starter.count())) {
    const shot = await screenshot("publicar-sin-boton");
    return { ok: false, target: "feed", detail: "No se encontró el botón para crear publicación.", screenshot: shot };
  }
  await starter.click();
  await pause(page, 1_500, 2_500);

  const editor = page.locator('div[role="textbox"][contenteditable="true"]').first();
  await editor.waitFor({ state: "visible", timeout: 15_000 });
  await editor.click();
  await editor.type(text, { delay: 15 });
  await pause(page, 800, 1_600);

  if (options.imagePath) {
    const fileInput = page.locator('input[type="file"]').last();
    if (await fileInput.count()) {
      await fileInput.setInputFiles(options.imagePath).catch(() => undefined);
      await pause(page, 2_500, 4_000);
      await clickButton(page, /^(siguiente|next|hecho|done)$/i, 'div[role="dialog"]');
      await pause(page, 1_200, 2_000);
    }
  }

  if (options.visibility === "connections") {
    const visibilityBtn = page.getByRole("button", { name: /cualquiera|anyone|quién puede ver/i }).first();
    if (await visibilityBtn.count()) {
      await visibilityBtn.click().catch(() => undefined);
      await pause(page, 800, 1_500);
      await page.getByText(/solo contactos|contactos|connections only/i).first().click().catch(() => undefined);
      await pause(page, 600, 1_200);
      await clickButton(page, /^(listo|guardar|done|save)$/i, 'div[role="dialog"]');
      await pause(page, 800, 1_500);
    }
  }

  const posted = await clickButton(page, /^(publicar|post)$/i, 'div[role="dialog"]');
  await pause(page, 2_000, 3_500);

  if (!posted) {
    const shot = await screenshot("publicar-sin-enviar");
    return { ok: false, target: "feed", detail: "No se pudo pulsar Publicar.", screenshot: shot };
  }

  commitOutbound("posts", { target: "feed", detail: text.slice(0, 120) });
  return { ok: true, target: "feed", detail: "Publicación creada." };
}

/** Lee las notificaciones recientes. */
export async function readNotifications(limit = 20): Promise<{ text: string; url?: string; age?: string }[]> {
  await ensureLoggedIn();
  const page = await getPage();
  await page.goto(`${LINKEDIN.base}/notifications/`, { waitUntil: "domcontentloaded" });
  await pause(page, 2_000, 3_200);
  await humanScroll(page, 3);

  const items = await page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll("article, li.nt-card-list__item, div.nt-card"))
      .map((el) => {
        const text = clean(el.textContent).slice(0, 400);
        if (!text) return null;
        const link = el.querySelector<HTMLAnchorElement>("a[href]");
        return { text, ...(link ? { url: link.href } : {}) };
      })
      .filter((n): n is NonNullable<typeof n> => n !== null);
  });

  return items.slice(0, limit);
}
