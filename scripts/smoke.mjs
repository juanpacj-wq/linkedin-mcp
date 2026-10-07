/**
 * Prueba de humo: arranca el servidor MCP como lo haría un cliente real,
 * lista las herramientas y verifica que responden. No toca LinkedIn.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "dist", "index.js");

// Carpeta de datos aislada para no tocar la sesión real.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "linkedin-pilot-smoke-"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: { ...process.env, LINKEDIN_PILOT_HOME: sandbox },
});

const client = new Client({ name: "smoke", version: "1.0.0" });

let failures = 0;
function check(label, condition, extra = "") {
  const mark = condition ? "OK  " : "FALLA";
  if (!condition) failures++;
  console.log(`${mark} ${label}${extra ? `: ${extra}` : ""}`);
}

try {
  await client.connect(transport);
  console.log("Conectado al servidor MCP.\n");

  const { tools } = await client.listTools();
  console.log(`Herramientas expuestas: ${tools.length}\n`);
  for (const t of tools) console.log(`  · ${t.name}`);
  console.log("");

  const names = new Set(tools.map((t) => t.name));
  const required = [
    // sesión
    "linkedin_session_status",
    "linkedin_login",
    // perfil de inicio a fin
    "linkedin_profile_read",
    "linkedin_profile_sections",
    "linkedin_profile_inspect_form",
    "linkedin_profile_edit",
    "linkedin_profile_headline",
    "linkedin_profile_about",
    "linkedin_profile_image",
    "linkedin_profile_open_to_work",
    "linkedin_profile_custom_url",
    // interacción con otros perfiles
    "linkedin_people_search",
    "linkedin_connect",
    "linkedin_message",
    "linkedin_follow",
    "linkedin_endorse",
    "linkedin_invitations",
    "linkedin_posts_read",
    "linkedin_post_react",
    "linkedin_post_comment",
    "linkedin_post_create",
    // empleo
    "linkedin_jobs_search",
    "linkedin_job_detail",
    "linkedin_job_apply",
    "linkedin_job_save",
    "linkedin_my_jobs",
    "linkedin_applications_log",
    // soporte
    "linkedin_answers_bank",
    "linkedin_usage",
    "linkedin_browser_snapshot",
  ];

  for (const name of required) check(`herramienta presente: ${name}`, names.has(name));

  // Herramientas que no necesitan navegador ni sesión.
  const sections = await client.callTool({ name: "linkedin_profile_sections", arguments: {} });
  const sectionsText = sections.content?.[0]?.text ?? "";
  check(
    "linkedin_profile_sections responde con secciones",
    sectionsText.includes("experience") && sectionsText.includes("openToWork"),
  );

  const usage = await client.callTool({ name: "linkedin_usage", arguments: {} });
  const usageText = usage.content?.[0]?.text ?? "";
  check("linkedin_usage devuelve topes", usageText.includes("applications"));

  const bankSet = await client.callTool({
    name: "linkedin_answers_bank",
    arguments: { action: "set", label: "Años de experiencia en Python", value: "5" },
  });
  check(
    "el banco de respuestas guarda",
    (bankSet.content?.[0]?.text ?? "").includes("5"),
  );

  const bankRead = await client.callTool({
    name: "linkedin_answers_bank",
    arguments: { action: "read" },
  });
  check(
    "el banco de respuestas persiste en disco",
    (bankRead.content?.[0]?.text ?? "").includes("anos de experiencia en python"),
  );

  // La guarda de acciones salientes debe bloquear sin confirm.
  const guarded = await client.callTool({
    name: "linkedin_connect",
    arguments: { target: "https://www.linkedin.com/in/ejemplo/" },
  });
  const guardedText = guarded.content?.[0]?.text ?? "";
  check(
    "las acciones visibles a terceros exigen confirm",
    guardedText.includes("confirm") && guardedText.startsWith("ERROR"),
    "bloqueada antes de abrir el navegador",
  );

  // Errores de sesión deben ser legibles, no trazas crudas.
  const noSession = await client.callTool({
    name: "linkedin_applications_log",
    arguments: {},
  });
  check("el historial responde vacío sin sesión", !noSession.isError);

  console.log("");
  if (failures === 0) {
    console.log("TODO EN VERDE: el servidor MCP arranca, expone las herramientas y responde.");
  } else {
    console.log(`${failures} comprobación(es) fallaron.`);
  }
} catch (err) {
  console.error("La prueba de humo falló:", err);
  failures++;
} finally {
  await client.close().catch(() => {});
  fs.rmSync(sandbox, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}
