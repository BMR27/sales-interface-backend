// Rellena la marca FC FV (Fuera de Cobertura Full Vector) de los leads que
// ya existían antes de que esa marca existiera.
//
// Un lead se etiqueta solo en dos momentos: al entrar por la API y al
// abrirse el panel de llamada. Los que ya estaban en el sistema quedan con
// `coberturaFv` en nulo y no muestran la pastilla en la lista hasta que
// alguien los abre; esto los pone al día de una vez.
//
// Agrupa por CP+colonia antes de preguntar: cien leads del mismo código
// postal son UNA consulta a FullVector, no cien.
//
//   # 1) sólo lee: cuántos hay y qué saldría
//   node scripts/backfill-cobertura-fv.js
//
//   # 2) aplica
//   node scripts/backfill-cobertura-fv.js --aplicar
//
// Opciones:
//   --revalidar   incluye también los leads que YA tienen marca, para
//                 reclasificarlos. Es lo que hay que correr el día que
//                 FullVector habilite cobertura nacional: la clasificación
//                 vive allá, así que basta con volver a preguntar.
//   --limite N    tope de combinaciones CP+colonia a consultar (pruebas).
//
// Necesita las FULLVECTOR_* del entorno; dentro del servicio en Railway ya
// están, así que se corre con:
//   railway ssh -s sales-backend "node scripts/backfill-cobertura-fv.js --aplicar"
const { PrismaClient } = require("@prisma/client");
const { checkCoverage, isEnabled } = require("../src/lib/fullvector");

const prisma = new PrismaClient();

const APLICAR = process.argv.includes("--aplicar");
const REVALIDAR = process.argv.includes("--revalidar");

function limite() {
  const i = process.argv.indexOf("--limite");
  if (i === -1) return null;
  const n = Number(process.argv[i + 1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const clave = (cp, colonia) => `${cp}|${colonia || ""}`;

async function main() {
  const where = {
    zipCode: { not: null },
    ...(REVALIDAR ? {} : { coberturaFv: null }),
  };

  const leads = await prisma.lead.findMany({
    where,
    select: { id: true, zipCode: true, colonia: true, coberturaFv: true },
  });

  const totalLeads = await prisma.lead.count();
  const sinCp = await prisma.lead.count({ where: { zipCode: null } });

  // Una consulta por combinación distinta, no por lead.
  const porCombinacion = new Map();
  for (const l of leads) {
    const k = clave(l.zipCode, l.colonia);
    if (!porCombinacion.has(k)) porCombinacion.set(k, { zipCode: l.zipCode, colonia: l.colonia, leads: [] });
    porCombinacion.get(k).leads.push(l);
  }

  let combinaciones = [...porCombinacion.values()];
  const tope = limite();
  if (tope) combinaciones = combinaciones.slice(0, tope);

  console.log(`leads en total: ${totalLeads}`);
  console.log(`sin código postal (no se pueden clasificar): ${sinCp}`);
  console.log(`${REVALIDAR ? "a revalidar" : "sin marca"}: ${leads.length} lead(s)`);
  console.log(`consultas a FullVector a realizar: ${combinaciones.length} (una por CP+colonia)\n`);

  if (combinaciones.length === 0) {
    console.log("Nada que hacer.");
    return;
  }

  if (!APLICAR) {
    console.log("Sólo lectura. Agrega --aplicar para etiquetarlos.");
    console.log("\nPrimeras combinaciones que se consultarían:");
    for (const c of combinaciones.slice(0, 10)) {
      console.log(`   CP ${c.zipCode}${c.colonia ? ` · ${c.colonia}` : ""}  →  ${c.leads.length} lead(s)`);
    }
    return;
  }

  if (!isEnabled()) {
    console.error("Faltan FULLVECTOR_API_URL / FULLVECTOR_SERVICE_EMAIL / FULLVECTOR_SERVICE_PASSWORD.");
    process.exitCode = 1;
    return;
  }

  let fcfv = 0;
  let conCobertura = 0;
  let sinRespuesta = 0;
  let marcados = 0;

  for (const c of combinaciones) {
    const covered = await checkCoverage(c.zipCode, c.colonia || undefined);
    if (covered === null) {
      // FullVector no pudo contestar: se deja como estaba, no se adivina.
      sinRespuesta += c.leads.length;
      continue;
    }

    const { count } = await prisma.lead.updateMany({
      where: { id: { in: c.leads.map((l) => l.id) } },
      data: { coberturaFv: covered, coberturaFvAt: new Date() },
    });
    marcados += count;
    if (covered) conCobertura += count;
    else fcfv += count;
  }

  console.log(`leads etiquetados: ${marcados}`);
  console.log(`   FC FV (fuera de cobertura): ${fcfv}`);
  console.log(`   con cobertura: ${conCobertura}`);
  if (sinRespuesta > 0) {
    console.log(`   sin clasificar (FullVector no respondió): ${sinRespuesta} — se pueden reintentar corriendo esto de nuevo`);
  }
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
