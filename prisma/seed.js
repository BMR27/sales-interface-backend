const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

function tiers(...pairs) {
  const result = [];
  for (let i = 0; i < pairs.length; i += 2) {
    result.push({ cantidad: pairs[i], precio: pairs[i + 1] });
  }
  return result;
}

const PRODUCTOS_FASE_1 = [
  {
    sku: "PS-SU-MAG-001",
    nombre: "Calm Mag",
    producto: "Magnesio glicinato",
    linea: "Suplemento",
    categoria: "Health & Wellness",
    subcategoria: "Cápsulas",
    presentacion: "Frasco de pet o vidrio color blanco",
    capacidad: "30 cápsulas",
    empaque: "Frasco de pet",
    pvpRetail: 175,
    pvpLeadsCpa: 599,
    ofertas: "1×$599, 2×$1099, 3×$1499 y 4×$1799",
    ofertasTiers: tiers(1, 599, 2, 1099, 3, 1499, 4, 1799),
    beneficios: "Favorecer sueño, relajación y manejo del estrés",
  },
  {
    sku: "PS-SU-MEN-001",
    nombre: "Prosta Vital Men",
    producto: "Beta-sitosterol",
    linea: "Suplemento",
    categoria: "Health & Wellness",
    subcategoria: "Cápsulas",
    presentacion: "Frasco de pet o vidrio color blanco",
    capacidad: "30 cápsulas",
    empaque: "Frasco de pet",
    pvpRetail: 220,
    pvpLeadsCpa: 599,
    ofertas: "1×$599, 2×$1099, 3×$1499 y 4×$1799",
    ofertasTiers: tiers(1, 599, 2, 1099, 3, 1499, 4, 1799),
    beneficios: "Auxiliar en el bienestar prostático y en el mantenimiento de la función urinaria normal",
  },
  {
    sku: "PS-SU-MET-001",
    nombre: "Metabolic Wellness",
    producto: "Berberina",
    linea: "Suplemento",
    categoria: "Health & Wellness",
    subcategoria: "Cápsulas",
    presentacion: "Frasco de pet o vidrio color blanco",
    capacidad: "30 cápsulas",
    empaque: "Frasco de pet",
    pvpRetail: 185,
    pvpLeadsCpa: 599,
    ofertas: "1×$599, 2×$1099, 3×$1499 y 4×$1799",
    ofertasTiers: tiers(1, 599, 2, 1099, 3, 1499, 4, 1799),
    beneficios: "Mejora el metabolismo y sensibilidad a la insulina",
  },
  {
    sku: "PS-SU-CIR-001",
    nombre: "LegLight",
    producto: "Castaño de Indias / Escina",
    linea: "Suplemento",
    categoria: "Health & Wellness",
    subcategoria: "Cápsulas",
    presentacion: "Frasco de pet o vidrio color blanco",
    capacidad: "30 cápsulas",
    empaque: "Frasco de pet",
    pvpRetail: 235,
    pvpLeadsCpa: 599,
    ofertas: "1×$599, 2×$1099, 3×$1499 y 4×$1799",
    ofertasTiers: tiers(1, 599, 2, 1099, 3, 1499, 4, 1799),
    beneficios: "Auxiliar en los síntomas por neuropatía diabética y para bienestar y función nerviosa",
  },
  {
    sku: "PS-SU-MET-002",
    nombre: "Neuroactive 360",
    producto: "Ácido Alfa Lipóico",
    linea: "Suplemento",
    categoria: "Health & Wellness",
    subcategoria: "Cápsulas",
    presentacion: "Frasco de pet o vidrio color blanco",
    capacidad: "30 cápsulas",
    empaque: "Frasco de pet",
    pvpRetail: 264,
    pvpLeadsCpa: 649,
    ofertas: "1×$649, 2×$1199, 3×$1599 y 4×$1899",
    ofertasTiers: tiers(1, 649, 2, 1199, 3, 1599, 4, 1899),
    beneficios: "Mejora la movilidad y desgaste en las articulaciones",
  },
  {
    sku: "PS-SU-JNT-001",
    nombre: "Moviflex",
    producto: "Colágeno tipo II + curcumina",
    linea: "Suplemento",
    categoria: "Health & Wellness",
    subcategoria: "Cápsulas",
    presentacion: "Frasco de pet o vidrio color blanco",
    capacidad: "30 cápsulas",
    empaque: "Frasco de pet",
    pvpRetail: 350,
    pvpLeadsCpa: 699,
    ofertas: "1×$699, 2×$1299, 3×$1699 y 4×$1999",
    ofertasTiers: tiers(1, 699, 2, 1299, 3, 1699, 4, 1999),
    beneficios: "Alivia la pesadez y el cansancio en las piernas",
  },
];

async function main() {
  // --- Tenant Legacy (espacio por defecto para datos preexistentes / seed local) ---
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
  }

  // --- Super admin (sin tenant) ---
  await prisma.user.upsert({
    where: { email: "superadmin@sales.com" },
    update: {},
    create: {
      nombre: "Super Admin",
      email: "superadmin@sales.com",
      password: await bcrypt.hash("superadmin123", 10),
      rol: "SUPER_ADMIN",
    },
  });

  // --- Admin ---
  const admin = await prisma.user.upsert({
    where: { email: "admin@sales.com" },
    update: { tenantId: tenant.id },
    create: {
      nombre: "Admin",
      email: "admin@sales.com",
      password: await bcrypt.hash("admin123", 10),
      rol: "ADMIN",
      tenantId: tenant.id,
    },
  });

  // --- Limpieza de datos dummy (leads/ventas/llamadas/leads entrantes de demo) ---
  await prisma.venta.deleteMany({});
  await prisma.llamada.deleteMany({});
  await prisma.incomingLead.deleteMany({});
  await prisma.lead.deleteMany({});
  await prisma.appSetting.deleteMany({});

  const dummyVendedor = await prisma.user.findUnique({ where: { email: "juan@sales.com" } });
  if (dummyVendedor) {
    await prisma.user.delete({ where: { id: dummyVendedor.id } });
  }

  // --- Vendedor real ---
  const gabriel = await prisma.user.upsert({
    where: { email: "gabriel@sales.com" },
    update: { tenantId: tenant.id },
    create: {
      nombre: "Gabriel Mendoza",
      email: "gabriel@sales.com",
      password: await bcrypt.hash("vendedor123", 10),
      rol: "VENDEDOR",
      tenantId: tenant.id,
    },
  });

  // --- Catálogo de productos (Perfect Self 2026 VW, Fase 1) ---
  for (const p of PRODUCTOS_FASE_1) {
    await prisma.producto.upsert({
      where: { tenantId_sku: { tenantId: tenant.id, sku: p.sku } },
      update: { ...p, tenantId: tenant.id },
      create: { ...p, tenantId: tenant.id },
    });
  }

  console.log("Seed completado:", { tenant: tenant.razonSocial, admin: admin.email, vendedor: gabriel.email, productos: PRODUCTOS_FASE_1.length });
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
