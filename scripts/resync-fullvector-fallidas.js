// Reintento de las ventas que nunca llegaron a FullVector.
//
//   # 1) ver que hay (sólo lee, no escribe nada):
//   DATABASE_URL="<prod>" node scripts/resync-fullvector-fallidas.js
//
//   # 2) reenviarlas de verdad (requiere además las FULLVECTOR_* del entorno):
//   DATABASE_URL="<prod>" FULLVECTOR_API_URL=... FULLVECTOR_SERVICE_EMAIL=... \
//   FULLVECTOR_SERVICE_PASSWORD=... node scripts/resync-fullvector-fallidas.js --aplicar
//
// Opciones:
//   --aplicar            escribe: reintenta cada venta listada.
//   --ids 12,34          sólo esas ventas (por id de venta), en vez de todas.
//   --completar-faltantes  manda la orden aunque al lead le falten campos de
//                        domicilio, rellenándolos con "POR CONFIRMAR" para que
//                        en FullVector se vea que hay que confirmarlos por
//                        teléfono. Es la excepción puntual: sin esta bandera,
//                        una dirección incompleta se sigue rechazando.
//
// El código postal nunca se rellena: FullVector resuelve cobertura y equipo
// con él. Un CP fuera de cobertura ya no es motivo de rechazo -- la orden se
// crea marcada NO_COVERAGE y queda en la base de prepago.
const { PrismaClient } = require("@prisma/client");
const { syncVentaToFullVector, isEnabled } = require("../src/lib/fullvector");

const prisma = new PrismaClient();

const APLICAR = process.argv.includes("--aplicar");
const COMPLETAR = process.argv.includes("--completar-faltantes");

function idsFiltro() {
  const i = process.argv.indexOf("--ids");
  if (i === -1) return null;
  return (process.argv[i + 1] || "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isInteger(x));
}

const CAMPOS_ENVIO = ["shippingStreet", "shippingNumber", "colonia", "municipio", "state", "zipCode", "telefono"];

(async () => {
  const ids = idsFiltro();
  const ventas = await prisma.venta.findMany({
    where: {
      NOT: { fullvectorSyncStatus: "SYNCED" },
      ...(ids ? { id: { in: ids } } : {}),
    },
    include: { lead: true },
    orderBy: { fecha: "asc" },
  });

  if (ventas.length === 0) {
    console.log("No hay ventas pendientes de sincronizar.");
    return;
  }

  console.log(`${ventas.length} venta(s) sin llegar a FullVector:\n`);
  for (const v of ventas) {
    const faltantes = CAMPOS_ENVIO.filter((c) => !v.lead?.[c]);
    console.log(
      `  venta #${v.id} folio=${v.folio || "(sin folio)"} lead=${v.leadId} ` +
        `${v.fecha.toISOString().slice(0, 10)} $${v.monto + (v.costoEnvio || 0)} ` +
        `${v.fullvectorSyncStatus} intentos=${v.fullvectorAttempts}`,
    );
    console.log(`      cliente: ${v.lead?.nombre || "?"} ${v.lead?.apellido || ""} — CP ${v.lead?.zipCode || "(falta)"}`);
    if (faltantes.length) console.log(`      le falta: ${faltantes.join(", ")}`);
    if (v.fullvectorError) console.log(`      último error: ${v.fullvectorError}`);
  }

  if (!APLICAR) {
    console.log("\nSólo lectura. Agrega --aplicar para reenviarlas (y --completar-faltantes si quieres");
    console.log("que las de dirección incompleta se manden con los huecos marcados POR CONFIRMAR).");
    return;
  }

  if (!isEnabled()) {
    console.error("\nFaltan FULLVECTOR_API_URL / FULLVECTOR_SERVICE_EMAIL / FULLVECTOR_SERVICE_PASSWORD en el entorno.");
    process.exitCode = 1;
    return;
  }

  console.log(`\nReenviando ${ventas.length} venta(s)${COMPLETAR ? " (completando campos faltantes)" : ""}...\n`);

  let ok = 0;
  for (const v of ventas) {
    // Los intentos se reinician: estas ventas pueden venir de un FAILED
    // permanente (o de haber agotado los 10 reintentos) y syncVenta... no
    // las tocaría de otro modo.
    await prisma.venta.update({
      where: { id: v.id },
      data: { fullvectorSyncStatus: "PENDING", fullvectorAttempts: 0, fullvectorError: null },
    });

    await syncVentaToFullVector(v.id, { completarFaltantes: COMPLETAR });

    const despues = await prisma.venta.findUnique({ where: { id: v.id } });
    if (despues.fullvectorSyncStatus === "SYNCED") {
      ok += 1;
      console.log(
        `  OK   venta #${v.id} folio=${v.folio} -> FullVector id=${despues.fullvectorOrderId || "(sin id)"}` +
          `${despues.fullvectorSinCobertura ? "  [PREPAGO: fuera de cobertura]" : ""}`,
      );
    } else {
      console.log(`  FALLA venta #${v.id} folio=${v.folio}: ${despues.fullvectorError}`);
    }
  }

  console.log(`\n${ok} de ${ventas.length} sincronizadas.`);
  console.log("Las marcadas [PREPAGO] salen en GET /api/admin/estadisticas/cruce-fullvector?prepago=1");
})()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
