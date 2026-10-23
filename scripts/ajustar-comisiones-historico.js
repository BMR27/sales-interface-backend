// Dos ajustes de una sola vez sobre el historico, para que el modelo de
// comisiones por bloques arranque parejo:
//
// 1) Las ventas anteriores nacieron con entregaExitosa=true porque el
//    frontend lo mandaba asi al cerrar la venta, no porque la paqueteria
//    confirmara nada. Se ponen en false: esperan la confirmacion de
//    FullVector igual que las nuevas.
//
// 2) Lead.asignadoPorId es nuevo y esta vacio, asi que las ventas no se le
//    pueden atribuir a ninguna coordinadora. El dato si existe en el kardex:
//    cada movimiento `lead.asignar` guarda quien lo hizo y que leads toco
//    (despues.leadIds). Se reconstruye desde ahi, tomando la ultima
//    asignacion de cada lead, que es la que vale.
//
//   node scripts/ajustar-comisiones-historico.js            # solo lee
//   node scripts/ajustar-comisiones-historico.js --aplicar
const { PrismaClient } = require("@prisma/client");
const { quincenaDe, recalcularQuincena, calcularQuincenaVendedora, calcularQuincenaCoordinadoras } = require("../src/lib/comisiones");

const prisma = new PrismaClient();
const APLICAR = process.argv.includes("--aplicar");
const money = (n) => `$${(Math.round(n * 100) / 100).toLocaleString("es-MX")}`;

(async () => {
  // --- 1) Entregas sin confirmar ---
  const marcadas = await prisma.venta.findMany({
    where: { entregaExitosa: true, entregaConfirmadaAt: null },
    select: { id: true, folio: true, tenantId: true, vendedorId: true, fecha: true },
  });
  console.log(`1) Ventas con entrega dada por buena sin confirmacion: ${marcadas.length}`);
  for (const v of marcadas.slice(0, 15)) console.log(`     ${v.folio}`);
  if (marcadas.length > 15) console.log(`     ...y ${marcadas.length - 15} mas`);

  if (APLICAR && marcadas.length > 0) {
    await prisma.venta.updateMany({
      where: { id: { in: marcadas.map((v) => v.id) } },
      data: { entregaExitosa: false },
    });
    console.log(`   -> ${marcadas.length} ventas pasan a esperar confirmacion de FullVector`);
  }

  // --- 2) Quien asigno cada lead, reconstruido del kardex ---
  const logs = await prisma.auditLog.findMany({
    where: { accion: "lead.asignar" },
    orderBy: { createdAt: "asc" },
    select: { userId: true, userNombre: true, userRol: true, despues: true, createdAt: true },
  });

  // La ultima asignacion gana: un lead reasignado pertenece a quien lo
  // movio al final.
  const asignadorPorLead = new Map();
  for (const log of logs) {
    const ids = log.despues?.leadIds;
    if (!Array.isArray(ids) || !log.userId) continue;
    for (const id of ids) {
      if (Number.isInteger(id)) asignadorPorLead.set(id, { userId: log.userId, nombre: log.userNombre });
    }
  }
  console.log(`\n2) Movimientos lead.asignar en el kardex: ${logs.length} -> ${asignadorPorLead.size} leads con asignador identificado`);

  const conVenta = await prisma.venta.findMany({ select: { leadId: true, folio: true } });
  const atribuibles = conVenta.filter((v) => asignadorPorLead.has(v.leadId));
  console.log(`   Ventas que quedan atribuidas: ${atribuibles.length} de ${conVenta.length}`);
  const porCoordinadora = new Map();
  for (const v of atribuibles) {
    const a = asignadorPorLead.get(v.leadId);
    porCoordinadora.set(a.nombre, (porCoordinadora.get(a.nombre) || 0) + 1);
  }
  for (const [nombre, n] of porCoordinadora) console.log(`     ${nombre}: ${n} ventas`);

  if (APLICAR && asignadorPorLead.size > 0) {
    // Se escribe solo sobre leads que existen; los ids del kardex pueden
    // apuntar a leads ya borrados.
    const existentes = await prisma.lead.findMany({
      where: { id: { in: [...asignadorPorLead.keys()] } },
      select: { id: true },
    });
    let escritos = 0;
    for (const { id } of existentes) {
      await prisma.lead.update({
        where: { id },
        data: { asignadoPorId: asignadorPorLead.get(id).userId },
      });
      escritos += 1;
    }
    console.log(`   -> ${escritos} leads con asignadoPorId escrito`);
  }

  // --- 3) Recalcular las quincenas tocadas ---
  if (APLICAR) {
    const grupos = new Map();
    for (const v of marcadas) {
      const q = quincenaDe(v.fecha);
      grupos.set(`${v.tenantId}|${v.vendedorId}|${q.clave}`, v);
    }
    for (const v of grupos.values()) {
      await recalcularQuincena(v.tenantId, v.vendedorId, v.fecha);
    }
    console.log(`\n3) ${grupos.size} quincena(s) recalculada(s)`);
  }

  // --- Corte resultante ---
  const hoy = new Date();
  const vendedoras = await prisma.user.findMany({ where: { rol: "VENDEDOR" }, select: { id: true, nombre: true, tenantId: true } });
  let total = 0;
  console.log(`\nCorte ${APLICAR ? "resultante" : "si se aplicara"} (quincena en curso):`);
  for (const v of vendedoras) {
    if (!v.tenantId) continue;
    const q = await calcularQuincenaVendedora(v.tenantId, v.id, hoy);
    if (!q.ventas.length) continue;
    total += q.comision;
    const pend = q.ventas.filter((d) => !d.cuenta).reduce((s, d) => s + d.piezas, 0);
    console.log(`  ${v.nombre.slice(0, 32).padEnd(32)} piezas=${String(q.piezas).padStart(2)} -> ${money(q.comision).padStart(6)}${pend ? `   (${pend} esperando entrega)` : ""}`);
  }
  const coord = await calcularQuincenaCoordinadoras(1, hoy);
  console.log(`  --`);
  for (const c of coord.coordinadoras) console.log(`  ${c.nombre.slice(0, 32).padEnd(32)} ventas=${c.ventas} -> ${money(c.comision)}`);
  console.log(`\n  TOTAL: vendedoras ${money(total)} + coordinacion ${money(coord.total)} = ${money(total + coord.total)}`);

  if (!APLICAR) console.log("\nSolo lectura. Agrega --aplicar para escribirlo.");
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error("Fallo el ajuste:", err.message);
  await prisma.$disconnect();
  process.exit(1);
});
