#!/usr/bin/env node
import { CONFIG, PATHS, DAILY_LIMITS, ensureDirs } from "./config.js";
import { errorMessage } from "./logger.js";
import {
  sessionStatus,
  interactiveLogin,
  closeBrowser,
  exportCookies,
} from "./browser/session.js";
import { readProfile } from "./tools/profile.js";
import { searchJobs, applyToJob, getJobDetail } from "./tools/jobs.js";
import { usageToday, listApplications, readAnswerBank } from "./state/store.js";

function print(value: unknown): void {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

const HELP = `
linkedin-pilot — control de LinkedIn desde la terminal

  login                     Abre el navegador para iniciar sesión a mano (una sola vez).
  status                    Muestra si la sesión está viva y el consumo del día.
  doctor                    Diagnóstico completo: navegador, sesión, rutas, banco de respuestas.
  profile [objetivo]        Lee un perfil ("me" por defecto).
  jobs <palabras> [lugar]   Busca ofertas con Solicitud sencilla.
  job <id|url>              Detalle de una oferta.
  apply <id|url>            Simula la postulación y muestra qué preguntas faltan.
  apply <id|url> --send     Postula de verdad.
  applications              Historial local de postulaciones.
  cookies [ruta]            Exporta las cookies de sesión a un archivo.
  close                     Cierra el navegador.

Variables de entorno útiles:
  LINKEDIN_PILOT_HOME       Carpeta de datos (por defecto ~/.linkedin-pilot)
  LINKEDIN_PILOT_HEADLESS   1 para ocultar la ventana (no recomendado)
  LINKEDIN_PILOT_CHANNEL    chrome | msedge | chromium
`;

async function doctor(): Promise<void> {
  ensureDirs();
  print("== Configuración ==");
  print({
    carpetaDeDatos: PATHS.home,
    perfilDelNavegador: PATHS.browserProfile,
    canal: CONFIG.channel,
    ventanaVisible: !CONFIG.headless,
    exigeConfirmacion: CONFIG.requireConfirm,
    topesDiarios: DAILY_LIMITS,
  });

  print("\n== Navegador ==");
  try {
    await import("playwright").then(async (pw) => {
      const path = pw.chromium.executablePath();
      print({ ejecutablePorDefecto: path });
    });
  } catch (err) {
    print({ error: errorMessage(err) });
  }

  print("\n== Sesión ==");
  try {
    const status = await sessionStatus();
    print(status);
    if (!status.loggedIn) {
      print('\n→ Ejecuta "npm run login" (o "linkedin-pilot login") para iniciar sesión.');
    }
  } catch (err) {
    print({ error: errorMessage(err) });
  }

  print("\n== Banco de respuestas ==");
  const bank = readAnswerBank();
  print({
    cvPorDefecto: bank.defaultResume ?? "(sin definir)",
    datosDePerfil: Object.keys(bank.profile).length,
    respuestasGuardadas: Object.keys(bank.answers).length,
  });

  print("\n== Consumo de hoy ==");
  print(usageToday());
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      print(HELP);
      return;

    case "login": {
      print("Abriendo el navegador. Inicia sesión en la ventana (incluida la verificación en dos pasos)...");
      const status = await interactiveLogin();
      print(status);
      print("\nListo. La sesión queda guardada; no hará falta repetir esto salvo que LinkedIn la cierre.");
      return;
    }

    case "status":
      print({ sesion: await sessionStatus(), consumoDeHoy: usageToday() });
      return;

    case "doctor":
      await doctor();
      return;

    case "profile":
      print(await readProfile(args[0]));
      return;

    case "jobs": {
      const keywords = args.filter((a) => !a.startsWith("--")).join(" ");
      if (!keywords) throw new Error('Uso: linkedin-pilot jobs "ingeniero de datos" [ciudad]');
      const results = await searchJobs({
        keywords,
        easyApplyOnly: true,
        limit: 25,
        datePosted: "week",
      });
      print(results);
      return;
    }

    case "job": {
      const job = args[0];
      if (!job) throw new Error("Uso: linkedin-pilot job <id|url>");
      print(await getJobDetail(job));
      return;
    }

    case "apply": {
      const job = args[0];
      if (!job) throw new Error("Uso: linkedin-pilot apply <id|url> [--send]");
      const send = args.includes("--send");
      const result = await applyToJob(job, { dryRun: !send, confirm: send });
      print(result);
      if (result.status === "needs-answers") {
        print(
          "\nFaltan respuestas. Guárdalas con:\n" +
            '  linkedin_answers_bank {"action":"set","label":"<pregunta>","value":"<respuesta>"}\n' +
            "o pásalas en `answers` al volver a postular.",
        );
      }
      return;
    }

    case "applications":
      print(listApplications(100));
      return;

    case "cookies":
      print({ exportado: await exportCookies(args[0]) });
      return;

    case "close":
      await closeBrowser();
      print("Navegador cerrado.");
      return;

    default:
      print(`Comando desconocido: ${command}`);
      print(HELP);
      process.exitCode = 1;
  }
}

main()
  .then(async () => {
    await closeBrowser();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(`\nERROR: ${errorMessage(err)}`);
    await closeBrowser();
    process.exit(1);
  });
