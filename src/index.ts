#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { CONFIG, DAILY_LIMITS, PATHS, ensureDirs } from "./config.js";
import { log, errorMessage } from "./logger.js";
import {
  sessionStatus,
  interactiveLogin,
  closeBrowser,
  exportCookies,
  importCookies,
} from "./browser/session.js";
import { voyagerRequest } from "./voyager/client.js";
import {
  readProfile,
  openSectionEditor,
  editSection,
  updateHeadline,
  updateAbout,
  uploadProfileImage,
  setOpenToWork,
  setCustomUrl,
  SECTIONS,
  type SectionKey,
} from "./tools/profile.js";
import {
  searchPeople,
  sendInvitation,
  sendMessage,
  toggleFollow,
  endorseSkills,
  listPendingInvitations,
  respondToInvitation,
  withdrawInvitation,
} from "./tools/network.js";
import {
  readPosts,
  reactToPost,
  commentOnPost,
  createPost,
  readNotifications,
} from "./tools/engage.js";
import {
  searchJobs,
  getJobDetail,
  applyToJob,
  toggleSaveJob,
  myJobs,
} from "./tools/jobs.js";
import {
  snapshotPage,
  navigate,
  clickElement,
  typeInto,
  scrollPage,
  capture,
} from "./tools/browser.js";
import {
  usageToday,
  listApplications,
  listOutreach,
  readAnswerBank,
  writeAnswerBank,
  rememberAnswer,
} from "./state/store.js";

ensureDirs();

const server = new McpServer(
  { name: "linkedin-pilot", version: "1.0.0" },
  {
    instructions:
      "Controla LinkedIn con la sesión real del usuario en un navegador persistente. " +
      "Empieza siempre por `linkedin_session_status`. Las acciones visibles para terceros " +
      "(invitaciones, mensajes, comentarios, publicaciones, postulaciones) exigen `confirm: true`. " +
      "Para postular usa primero `linkedin_job_apply` en simulación (por defecto) y revisa las " +
      "preguntas pendientes antes de enviar. Si una herramienta no encuentra un botón, usa " +
      "`linkedin_browser_snapshot` y las herramientas de navegador para terminar a mano.",
  },
);

/** Envuelve el resultado como texto JSON y convierte errores en respuesta legible. */
function ok(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) },
    ],
  };
}

function fail(err: unknown) {
  const message = errorMessage(err);
  log.error("herramienta falló", message);
  return {
    content: [{ type: "text" as const, text: `ERROR: ${message}` }],
    isError: true,
  };
}

function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>,
): void {
  server.registerTool(name, { description, inputSchema }, (async (args: unknown) => {
    try {
      return ok(await handler(args as z.objectOutputType<S, z.ZodTypeAny>));
    } catch (err) {
      return fail(err);
    }
  }) as never);
}

/* ================================================================== */
/* Sesión                                                              */
/* ================================================================== */

tool(
  "linkedin_session_status",
  "Comprueba si hay sesión de LinkedIn activa en el navegador persistente. Devuelve el nombre, " +
    "el identificador público y cuándo caduca la cookie. Llama a esto antes que nada.",
  {},
  async () => {
    const status = await sessionStatus();
    return {
      ...status,
      perfilDelNavegador: PATHS.browserProfile,
      consumoDeHoy: usageToday(),
    };
  },
);

tool(
  "linkedin_login",
  "Abre una ventana de navegador en la pantalla de inicio de sesión y espera a que el usuario " +
    "entre a mano (contraseña, verificación en dos pasos, captcha). La sesión queda guardada en " +
    "disco y se reutiliza en llamadas futuras. No automatiza el login a propósito: hacerlo es lo " +
    "que dispara los bloqueos de LinkedIn.",
  {
    timeoutSeconds: z
      .number()
      .int()
      .min(60)
      .max(900)
      .optional()
      .describe("Cuánto esperar a que termines de iniciar sesión. Por defecto 300."),
  },
  async ({ timeoutSeconds }) => interactiveLogin((timeoutSeconds ?? 300) * 1000),
);

tool(
  "linkedin_session_cookies",
  "Exporta las cookies de la sesión a un archivo, o importa un li_at/JSESSIONID obtenido del " +
    "navegador personal. Útil para respaldar la sesión o para arrancar sin pasar por el login.",
  {
    action: z.enum(["export", "import"]),
    liAt: z.string().optional().describe("Valor de la cookie li_at (solo para import)."),
    jsessionid: z.string().optional().describe("Valor de la cookie JSESSIONID (solo para import)."),
    filePath: z.string().optional().describe("Ruta del archivo JSON de cookies."),
  },
  async ({ action, liAt, jsessionid, filePath }) => {
    if (action === "export") {
      const path = await exportCookies(filePath);
      return { exportado: path };
    }
    await importCookies({
      ...(liAt ? { liAt } : {}),
      ...(jsessionid ? { jsessionid } : {}),
      ...(filePath ? { cookiesJsonPath: filePath } : {}),
    });
    return { importado: true, estado: await sessionStatus() };
  },
);

tool(
  "linkedin_close_browser",
  "Cierra el navegador. La sesión sigue guardada en disco: la próxima herramienta lo vuelve a abrir.",
  {},
  async () => {
    await closeBrowser();
    return { cerrado: true };
  },
);

/* ================================================================== */
/* Perfil                                                              */
/* ================================================================== */

tool(
  "linkedin_profile_read",
  "Lee un perfil completo (el propio por defecto): titular, acerca de, experiencia, educación, " +
    "aptitudes, certificaciones e idiomas.",
  {
    target: z
      .string()
      .optional()
      .describe('"me" para el propio, o una URL / identificador público como "juan-perez-123".'),
  },
  async ({ target }) => readProfile(target),
);

tool(
  "linkedin_profile_sections",
  "Lista las secciones del perfil que se pueden editar, con los campos habituales de cada una.",
  {},
  async () =>
    Object.entries(SECTIONS).map(([key, spec]) => ({
      seccion: key,
      titulo: spec.title,
      camposHabituales: spec.commonFields ?? [],
    })),
);

tool(
  "linkedin_profile_inspect_form",
  "Abre el editor de una sección y devuelve EXACTAMENTE los campos que LinkedIn muestra ahora " +
    "mismo (etiqueta, tipo, si es obligatorio, opciones disponibles) sin guardar nada. " +
    "Úsalo antes de editar una sección por primera vez: así los nombres de campo que pases " +
    "después coinciden con los reales, aunque LinkedIn los haya cambiado.",
  {
    section: z
      .string()
      .describe(`Una de: ${Object.keys(SECTIONS).join(", ")}`),
  },
  async ({ section }) => openSectionEditor(section as SectionKey),
);

tool(
  "linkedin_profile_edit",
  "Rellena una sección del perfil y opcionalmente la guarda. Los campos se identifican por su " +
    "etiqueta visible (admite coincidencia parcial). Con save=false deja el formulario abierto y " +
    "relleno para que lo revises: es lo recomendado la primera vez.",
  {
    section: z.string().describe(`Una de: ${Object.keys(SECTIONS).join(", ")}`),
    values: z
      .record(z.string())
      .describe('Etiqueta → valor. Ejemplo: {"Cargo": "Ingeniero de datos", "Empresa": "ACME"}'),
    save: z.boolean().optional().describe("true para guardar. Por defecto false (solo rellena)."),
  },
  async ({ section, values, save }) =>
    editSection(section as SectionKey, values, { save: save === true }),
);

tool(
  "linkedin_profile_headline",
  "Cambia el titular del perfil (la línea bajo el nombre).",
  {
    headline: z.string().max(220),
    save: z.boolean().optional(),
  },
  async ({ headline, save }) => updateHeadline(headline, save !== false),
);

tool(
  "linkedin_profile_about",
  'Reescribe la sección "Acerca de".',
  {
    text: z.string().max(2600),
    save: z.boolean().optional(),
  },
  async ({ text, save }) => updateAbout(text, save !== false),
);

tool(
  "linkedin_profile_image",
  "Sube la foto de perfil o la imagen de portada.",
  {
    kind: z.enum(["photo", "banner"]),
    filePath: z.string().describe("Ruta al archivo de imagen."),
  },
  async ({ kind, filePath }) => uploadProfileImage(kind, filePath),
);

tool(
  "linkedin_profile_open_to_work",
  'Configura "Abierto a trabajar": cargos, ubicaciones, tipos de empleo y quién puede verlo.',
  {
    values: z
      .record(z.string())
      .describe('Ejemplo: {"Cargos": "Ingeniero de datos", "Ubicaciones": "Bogotá", "Quién puede ver": "Solo responsables de selección"}'),
    save: z.boolean().optional(),
  },
  async ({ values, save }) => setOpenToWork(values, save !== false),
);

tool(
  "linkedin_profile_custom_url",
  "Cambia la URL personalizada del perfil (linkedin.com/in/loquesea).",
  { vanity: z.string().min(3).max(100) },
  async ({ vanity }) => setCustomUrl(vanity),
);

/* ================================================================== */
/* Red y personas                                                      */
/* ================================================================== */

tool(
  "linkedin_people_search",
  "Busca personas por palabras clave, con filtros de grado de contacto.",
  {
    keywords: z.string(),
    limit: z.number().int().min(1).max(50).optional(),
    connectionDegree: z.array(z.enum(["1", "2", "3"])).optional(),
    page: z.number().int().min(1).optional(),
  },
  async (args) =>
    searchPeople({
      keywords: args.keywords,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.connectionDegree ? { connectionDegree: args.connectionDegree } : {}),
      ...(args.page !== undefined ? { page: args.page } : {}),
    }),
);

tool(
  "linkedin_connect",
  "Envía una invitación a conectar, con nota opcional (máx. 300 caracteres). Acción visible para " +
    "la otra persona: exige confirm=true.",
  {
    target: z.string().describe("URL del perfil o identificador público."),
    note: z.string().max(300).optional(),
    confirm: z.boolean().optional().describe("Debe ser true para enviar de verdad."),
  },
  async ({ target, note, confirm }) => sendInvitation(target, note, confirm),
);

tool(
  "linkedin_message",
  "Envía un mensaje directo a un contacto. Exige confirm=true.",
  {
    target: z.string(),
    text: z.string().min(1).max(8000),
    confirm: z.boolean().optional(),
  },
  async ({ target, text, confirm }) => sendMessage(target, text, confirm),
);

tool(
  "linkedin_follow",
  "Sigue o deja de seguir un perfil. Exige confirm=true.",
  {
    target: z.string(),
    follow: z.boolean().optional().describe("true para seguir (por defecto), false para dejar de seguir."),
    confirm: z.boolean().optional(),
  },
  async ({ target, follow, confirm }) => toggleFollow(target, follow !== false, confirm),
);

tool(
  "linkedin_endorse",
  "Valida aptitudes en el perfil de otra persona. Exige confirm=true.",
  {
    target: z.string(),
    skills: z.array(z.string()).min(1),
    confirm: z.boolean().optional(),
  },
  async ({ target, skills, confirm }) => endorseSkills(target, skills, confirm),
);

tool(
  "linkedin_invitations",
  "Lista invitaciones pendientes (recibidas o enviadas), y permite aceptar, ignorar o retirar.",
  {
    action: z.enum(["list-received", "list-sent", "accept", "ignore", "withdraw"]),
    personName: z.string().optional().describe("Nombre exacto, necesario para aceptar/ignorar/retirar."),
    confirm: z.boolean().optional(),
  },
  async ({ action, personName, confirm }) => {
    if (action === "list-received") return listPendingInvitations("received");
    if (action === "list-sent") return listPendingInvitations("sent");
    if (!personName) throw new Error("Falta `personName`.");
    if (action === "withdraw") return withdrawInvitation(personName, confirm);
    return respondToInvitation(personName, action === "accept" ? "accept" : "ignore", confirm);
  },
);

/* ================================================================== */
/* Contenido                                                           */
/* ================================================================== */

tool(
  "linkedin_posts_read",
  'Lee publicaciones del feed ("feed") o la actividad reciente de un perfil.',
  {
    source: z.string().optional().describe('"feed" (por defecto) o URL/identificador de un perfil.'),
    limit: z.number().int().min(1).max(50).optional(),
  },
  async ({ source, limit }) => readPosts(source ?? "feed", limit ?? 10),
);

tool(
  "linkedin_post_react",
  "Reacciona a una publicación. Exige confirm=true.",
  {
    postUrl: z.string(),
    reaction: z.enum(["like", "celebrate", "support", "love", "insightful", "funny"]).optional(),
    confirm: z.boolean().optional(),
  },
  async ({ postUrl, reaction, confirm }) => reactToPost(postUrl, reaction ?? "like", confirm),
);

tool(
  "linkedin_post_comment",
  "Comenta una publicación. Exige confirm=true.",
  {
    postUrl: z.string(),
    text: z.string().min(1).max(3000),
    confirm: z.boolean().optional(),
  },
  async ({ postUrl, text, confirm }) => commentOnPost(postUrl, text, confirm),
);

tool(
  "linkedin_post_create",
  "Publica en el feed. Exige confirm=true.",
  {
    text: z.string().min(1).max(3000),
    visibility: z.enum(["anyone", "connections"]).optional(),
    imagePath: z.string().optional(),
    confirm: z.boolean().optional(),
  },
  async ({ text, visibility, imagePath, confirm }) =>
    createPost(text, {
      ...(visibility ? { visibility } : {}),
      ...(imagePath ? { imagePath } : {}),
      ...(confirm !== undefined ? { confirm } : {}),
    }),
);

tool(
  "linkedin_notifications",
  "Lee las notificaciones recientes.",
  { limit: z.number().int().min(1).max(50).optional() },
  async ({ limit }) => readNotifications(limit ?? 20),
);

/* ================================================================== */
/* Empleos                                                             */
/* ================================================================== */

tool(
  "linkedin_jobs_search",
  "Busca ofertas de empleo con los filtros de LinkedIn. Marca cuáles admiten Solicitud sencilla " +
    "y cuáles ya tienes registradas como postuladas.",
  {
    keywords: z.string(),
    location: z.string().optional(),
    easyApplyOnly: z.boolean().optional(),
    datePosted: z.enum(["day", "week", "month", "any"]).optional(),
    experienceLevel: z
      .array(z.enum(["internship", "entry", "associate", "mid-senior", "director", "executive"]))
      .optional(),
    workplace: z.array(z.enum(["on-site", "remote", "hybrid"])).optional(),
    jobType: z.array(z.enum(["full-time", "part-time", "contract", "temporary", "internship"])).optional(),
    sortBy: z.enum(["date", "relevance"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    start: z.number().int().min(0).optional(),
  },
  async (args) => searchJobs(args as Parameters<typeof searchJobs>[0]),
);

tool(
  "linkedin_job_detail",
  "Trae el detalle completo de una oferta: descripción, empresa, ubicación, número de solicitantes " +
    "y si admite Solicitud sencilla.",
  { job: z.string().describe("Id numérico o URL de la oferta.") },
  async ({ job }) => getJobDetail(job),
);

tool(
  "linkedin_job_apply",
  "Postula a una oferta con Solicitud sencilla. POR DEFECTO SIMULA: recorre todo el formulario, " +
    "lo rellena y se detiene antes de enviar, devolviendo qué preguntas faltan por responder. " +
    "Para enviar de verdad hay que pasar dryRun=false Y confirm=true. Las respuestas nuevas se " +
    "guardan para reutilizarlas en las siguientes ofertas.",
  {
    job: z.string().describe("Id numérico o URL de la oferta."),
    answers: z
      .record(z.string())
      .optional()
      .describe('Respuestas por etiqueta. Ejemplo: {"Años de experiencia en Python": "5"}'),
    resumePath: z.string().optional().describe("Ruta al CV en PDF."),
    dryRun: z.boolean().optional().describe("Por defecto true."),
    confirm: z.boolean().optional().describe("Obligatorio para enviar de verdad."),
    followCompany: z.boolean().optional().describe("Seguir a la empresa al postular. Por defecto false."),
    rememberAnswers: z.boolean().optional(),
    maxSteps: z.number().int().min(1).max(30).optional(),
  },
  async ({ job, ...rest }) => applyToJob(job, rest),
);

tool(
  "linkedin_job_save",
  "Guarda o quita una oferta de la lista de guardados.",
  { job: z.string(), save: z.boolean().optional() },
  async ({ job, save }) => toggleSaveJob(job, save !== false),
);

tool(
  "linkedin_my_jobs",
  'Lista tus ofertas guardadas o tus solicitudes enviadas según LinkedIn ("Mis empleos").',
  { tab: z.enum(["saved", "applied"]).optional() },
  async ({ tab }) => myJobs(tab ?? "applied"),
);

tool(
  "linkedin_applications_log",
  "Historial local de postulaciones hechas con esta herramienta, con su estado y las respuestas dadas.",
  { limit: z.number().int().min(1).max(200).optional() },
  async ({ limit }) => listApplications(limit ?? 50),
);

/* ================================================================== */
/* Banco de respuestas y límites                                       */
/* ================================================================== */

tool(
  "linkedin_answers_bank",
  "Consulta o edita el banco de respuestas que se reutiliza al postular (datos de contacto, " +
    "años de experiencia, disponibilidad, CV por defecto...). Cuanto más completo, menos se " +
    "atascan las postulaciones.",
  {
    action: z.enum(["read", "set", "set-profile", "set-resume"]),
    label: z.string().optional(),
    value: z.string().optional(),
    entries: z.record(z.string()).optional().describe("Varias claves de una vez."),
  },
  async ({ action, label, value, entries }) => {
    if (action === "read") return readAnswerBank();

    const bank = readAnswerBank();
    if (action === "set-resume") {
      if (!value) throw new Error("Falta `value` con la ruta del CV.");
      bank.defaultResume = value;
      writeAnswerBank(bank);
      return { cvPorDefecto: value };
    }
    if (action === "set-profile") {
      if (!entries) throw new Error("Falta `entries`.");
      bank.profile = { ...bank.profile, ...entries };
      writeAnswerBank(bank);
      return bank.profile;
    }
    if (entries) {
      for (const [k, v] of Object.entries(entries)) rememberAnswer(k, v);
      return readAnswerBank().answers;
    }
    if (!label || value === undefined) throw new Error("Faltan `label` y `value`.");
    rememberAnswer(label, value);
    return readAnswerBank().answers;
  },
);

tool(
  "linkedin_usage",
  "Muestra cuántas acciones llevas hoy frente a los topes diarios, y el registro de interacciones.",
  { showOutreach: z.boolean().optional() },
  async ({ showOutreach }) => ({
    consumoDeHoy: usageToday(),
    topes: DAILY_LIMITS,
    exigeConfirmacion: CONFIG.requireConfirm,
    ...(showOutreach ? { interacciones: listOutreach(50) } : {}),
  }),
);

/* ================================================================== */
/* Vía de escape: control directo del navegador                        */
/* ================================================================== */

tool(
  "linkedin_browser_snapshot",
  "Radiografía de la página actual: enlaces, botones y campos con una referencia para pulsarlos " +
    "o rellenarlos. Es la salida de emergencia cuando una herramienta de alto nivel no encuentra algo.",
  {
    scopeSelector: z.string().optional().describe('Por ejemplo \'div[role="dialog"]\' o "main".'),
    textLimit: z.number().int().min(200).max(20000).optional(),
  },
  async ({ scopeSelector, textLimit }) => snapshotPage(scopeSelector, textLimit ?? 4000),
);

tool(
  "linkedin_browser_navigate",
  "Navega a una URL de LinkedIn y devuelve la radiografía de la página.",
  { url: z.string() },
  async ({ url }) => navigate(url),
);

tool(
  "linkedin_browser_click",
  "Pulsa un elemento por su `ref` (de un snapshot previo) o por su texto visible.",
  { ref: z.string().optional(), text: z.string().optional() },
  async ({ ref, text }) =>
    clickElement({ ...(ref ? { ref } : {}), ...(text ? { text } : {}) }),
);

tool(
  "linkedin_browser_type",
  "Escribe en un campo identificado por `ref`.",
  { ref: z.string(), text: z.string(), submit: z.boolean().optional() },
  async ({ ref, text, submit }) => typeInto(ref, text, submit === true),
);

tool(
  "linkedin_browser_scroll",
  "Desplaza la página para cargar contenido diferido.",
  { steps: z.number().int().min(1).max(20).optional() },
  async ({ steps }) => scrollPage(steps ?? 4),
);

tool(
  "linkedin_browser_screenshot",
  "Guarda una captura de la pantalla actual y devuelve la ruta.",
  { name: z.string().optional() },
  async ({ name }) => capture(name ?? "manual"),
);

tool(
  "linkedin_voyager_request",
  "Llamada directa a la API interna de LinkedIn (Voyager) reutilizando la sesión del navegador. " +
    "Atajo avanzado para leer datos que la interfaz no expone cómodamente. No es una API pública: " +
    "las rutas cambian sin aviso, así que trata los fallos como normales y usa las otras herramientas.",
  {
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional(),
    path: z.string().describe('Ruta relativa, por ejemplo "me" o "identity/dash/profiles?q=..."'),
    body: z.unknown().optional(),
  },
  async ({ method, path, body }) => voyagerRequest(method ?? "GET", path, body),
);

/* ================================================================== */

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("servidor MCP linkedin-pilot listo", { datos: PATHS.home });
}

process.on("SIGINT", async () => {
  await closeBrowser();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await closeBrowser();
  process.exit(0);
});

main().catch((err) => {
  process.stderr.write(`linkedin-pilot no arrancó: ${errorMessage(err)}\n`);
  process.exit(1);
});
