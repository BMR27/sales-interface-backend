// Ejecutar UNA VEZ, manualmente, después de aplicar la migración que agrega
// Tenant + tenantId nullable, y ANTES de la migración que vuelve tenantId NOT NULL.
// Uso: node scripts/backfill-tenant.js
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  let tenant = await prisma.tenant.findFirst({ where: { razonSocial: "Legacy / Migración inicial" } });
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: {
        tipoPersona: "MORAL",
        razonSocial: "Legacy / Migración inicial",
        nombreComercial: "Espacio Legacy",
        emailContacto: "admin@sales.com",
        status: "ACTIVO",
        approvedAt: new Date(),
      },
    });
    console.log("Tenant Legacy creado:", tenant.id);
  } else {
    console.log("Tenant Legacy ya existía:", tenant.id);
  }

  const modelos = [
    "user", "lead", "venta", "apiKey", "incomingLead",
    "llamada", "producto", "movimientoInventario", "appSetting",
  ];

  for (const modelo of modelos) {
    const result = await prisma[modelo].updateMany({
      where: { tenantId: null },
      data: { tenantId: tenant.id },
    });
    console.log(`${modelo}: ${result.count} registros actualizados`);
  }

  console.log("Backfill completado.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
