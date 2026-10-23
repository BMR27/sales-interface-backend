// Recalcula Venta.comision con el modelo de bloques de piezas sobre todas
// las quincenas que tengan ventas.
//
//   # ver que cambiaria (solo lee):
//   node scripts/recalcular-comisiones.js
//
//   # aplicarlo:
//   node scripts/recalcular-comisiones.js --aplicar
const { PrismaClient } = require("@prisma/client");
const { quincenaDe, calcularQuincenaVendedora, recalcularQuincena } = require("../src/lib/comisiones");

const prisma = new PrismaClient();
const APLICAR = process.argv.includes("--aplicar");
const money = (n) => `$${(Math.round(n * 100) / 100).toLocaleString("es-MX")}`;

(async () => {
  const ventas = await prisma.venta.findMany({
    select: { tenantId: true, vendedorId: true, fecha: true, comision: true },
    orderBy: { fecha: "asc" },
  });
  if (ventas.length === 0) {
    console.log("No hay ventas.");
    return;
  }

  // Una corrida por cada combinacion tenant + vendedora + quincena.
  const grupos = new Map();
  for (const v of ventas) {
    const q = quincenaDe(v.fecha);
    const clave = `${v.tenantId}|${v.vendedorId}|${q.clave}`;
    if (!grupos.has(clave)) {
      grupos.set(clave, { tenantId: v.tenantId, vendedorId: v.vendedorId, fecha: v.fecha, quincena: q.clave, antes: 0 });
    }
    grupos.get(clave).antes += v.comision;
  }

  const nombres = new Map(
    (await prisma.user.findMany({ select: { id: true, nombre: true } })).map((u) => [u.id, u.nombre]),
  );

  let totalAntes = 0;
  let totalDespues = 0;
  console.log(`${grupos.size} quincena(s) con ventas:\n`);

  for (const g of grupos.values()) {
    const calculo = APLICAR
      ? await recalcularQuincena(g.tenantId, g.vendedorId, g.fecha)
      : await calcularQuincenaVendedora(g.tenantId, g.vendedorId, g.fecha);

    totalAntes += g.antes;
    totalDespues += calculo.comision;

    const sinConfirmar = calculo.ventas.filter((d) => !d.cuenta).reduce((s, d) => s + d.piezas, 0);
    console.log(
      `  ${g.quincena}  ${(nombres.get(g.vendedorId) || `#${g.vendedorId}`).slice(0, 30).padEnd(30)}` +
        ` piezas=${String(calculo.piezas).padStart(3)} bloques=${String(calculo.bloques).padStart(2)}` +
        ` sobran=${calculo.sobrantes}  ${money(g.antes).padStart(10)} -> ${money(calculo.comision).padStart(8)}` +
        (sinConfirmar ? `   (${sinConfirmar} piezas sin entrega confirmada)` : ""),
    );
  }

  console.log(`\nTotal de comisiones: ${money(totalAntes)} -> ${money(totalDespues)}`);
  if (!APLICAR) console.log("\nSolo lectura. Agrega --aplicar para escribirlo.");

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error("Fallo el recalculo:", err.message);
  await prisma.$disconnect();
  process.exit(1);
});
