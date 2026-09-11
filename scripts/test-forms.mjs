/**
 * Valida el motor de formularios contra HTML real de LinkedIn (la pantalla de
 * inicio de sesión, que es pública). Comprueba que detecta campos, resuelve
 * sus etiquetas y encuentra los botones. No inicia sesión ni envía nada.
 */
import { getPage, closeBrowser } from "../dist/browser/session.js";
import { describeForm } from "../dist/browser/forms.js";
import { snapshotPage } from "../dist/tools/browser.js";

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "OK  " : "FALLA"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

try {
  const page = await getPage();
  await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const form = await describeForm(page, "main");
  console.log("\nCampos detectados:");
  for (const f of form.fields) {
    console.log(
      `  · [${f.kind}] "${f.label}" ${f.required ? "(obligatorio) " : ""}ref=${f.ref}`,
    );
  }
  console.log("\nBotones detectados:");
  for (const b of form.buttons.slice(0, 10)) console.log(`  · "${b.label}" ref=${b.ref}`);

  check("detecta campos en la página", form.fields.length >= 2, `${form.fields.length} campos`);
  check(
    "resuelve etiquetas legibles",
    form.fields.some((f) => /correo|email|tel|usuario/i.test(f.label)),
    form.fields.map((f) => f.label).join(" | "),
  );
  check(
    "identifica el campo de contraseña",
    form.fields.some((f) => /contrase|password/i.test(f.label)),
  );
  check("detecta botones", form.buttons.length >= 1, `${form.buttons.length} botones`);
  check(
    "asigna referencias únicas",
    new Set([...form.fields, ...form.buttons].map((x) => x.ref)).size ===
      form.fields.length + form.buttons.length,
  );

  // El snapshot de emergencia debe funcionar sobre cualquier página.
  const snap = await snapshotPage("main", 800);
  check("el snapshot devuelve URL y título", !!snap.url && !!snap.title, snap.title);
  check("el snapshot lista enlaces", Array.isArray(snap.links));
  check("el snapshot trae texto visible", snap.visibleText.length > 20);

  // Los refs deben poder usarse para localizar el elemento de vuelta.
  const firstField = form.fields[0];
  if (firstField) {
    const found = await page.locator(`[data-lp-ref="${firstField.ref}"]`).count();
    check("los refs vuelven a localizar el elemento", found === 1, `ref=${firstField.ref}`);
  }

  console.log("");
  console.log(
    failures === 0
      ? "MOTOR DE FORMULARIOS VALIDADO contra el HTML real de LinkedIn."
      : `${failures} comprobación(es) fallaron.`,
  );
} catch (err) {
  console.error("Fallo:", err);
  failures++;
} finally {
  await closeBrowser();
  process.exit(failures === 0 ? 0 : 1);
}
