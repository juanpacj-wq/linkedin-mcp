/**
 * Validación contra la cuenta real. NO guarda ni envía nada: solo abre
 * formularios para comprobar que se detectan sus campos, y hace búsquedas.
 */
import { openSectionEditor } from "../dist/tools/profile.js";
import { searchJobs, getJobDetail } from "../dist/tools/jobs.js";
import { searchPeople } from "../dist/tools/network.js";
import { closeBrowser, getPage } from "../dist/browser/session.js";

let fallos = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "OK  " : "FALLA"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) fallos++;
};

async function cerrarModal() {
  const page = await getPage();
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(700);
  // Si pregunta por descartar cambios, descartar.
  const descartar = page.getByRole("button", { name: /^(descartar|discard)$/i }).first();
  if (await descartar.count().catch(() => 0)) await descartar.click().catch(() => {});
  await page.waitForTimeout(700);
}

console.log("=== EDITORES DE PERFIL (se abren, no se guarda nada) ===\n");
for (const seccion of ["intro", "about", "experience", "education", "skill", "certification"]) {
  try {
    const form = await openSectionEditor(seccion);
    const obligatorios = form.fields.filter((f) => f.required).length;
    check(
      `editor "${seccion}" abre y expone campos`,
      form.fields.length > 0,
      `${form.fields.length} campos (${obligatorios} obligatorios) · "${form.title ?? ""}"`,
    );
    console.log(
      "      campos: " +
        form.fields.map((f) => `${f.label}[${f.kind}]${f.required ? "*" : ""}`).join(" · ").slice(0, 400),
    );
    await cerrarModal();
  } catch (err) {
    check(`editor "${seccion}" abre`, false, err.message.slice(0, 160));
    await cerrarModal();
  }
}

console.log("\n=== EMPLEOS ===\n");
try {
  const jobs = await searchJobs({
    keywords: "analista de datos",
    location: "Colombia",
    easyApplyOnly: true,
    datePosted: "month",
    limit: 8,
  });
  check("búsqueda de empleos devuelve resultados", jobs.length > 0, `${jobs.length} ofertas`);
  for (const j of jobs.slice(0, 5)) {
    console.log(`      · [${j.jobId}] ${j.title} — ${j.company} — ${j.location}${j.easyApply ? " (solicitud sencilla)" : ""}`);
  }
  const primera = jobs[0];
  if (primera) {
    const d = await getJobDetail(primera.jobId);
    check(
      "detalle de oferta trae título, empresa y descripción",
      !!d.title && !!d.company && d.description.length > 100,
      `${d.title} — ${d.company} — descripción ${d.description.length} car. — easyApply=${d.easyApply}`,
    );
  }
} catch (err) {
  check("búsqueda de empleos", false, err.message.slice(0, 200));
}

console.log("\n=== PERSONAS ===\n");
try {
  const people = await searchPeople({ keywords: "reclutador datos Colombia", limit: 5 });
  check("búsqueda de personas devuelve resultados", people.length > 0, `${people.length} perfiles`);
  for (const p of people.slice(0, 3)) console.log(`      · ${p.name} — ${p.headline.slice(0, 70)}`);
} catch (err) {
  check("búsqueda de personas", false, err.message.slice(0, 200));
}

console.log("");
console.log(fallos === 0 ? "VALIDACIÓN EN VIVO: TODO EN VERDE." : `${fallos} comprobación(es) fallaron.`);
await closeBrowser();
process.exit(fallos === 0 ? 0 : 1);
