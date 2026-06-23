const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
  const hashedPassword = await bcrypt.hash("admin123", 10);

  const admin = await prisma.user.upsert({
    where: { email: "admin@sales.com" },
    update: {},
    create: {
      nombre: "Admin",
      email: "admin@sales.com",
      password: hashedPassword,
      rol: "ADMIN",
    },
  });

  const vendedor = await prisma.user.upsert({
    where: { email: "juan@sales.com" },
    update: {},
    create: {
      nombre: "Juan Martinez",
      email: "juan@sales.com",
      password: await bcrypt.hash("vendedor123", 10),
      rol: "VENDEDOR",
    },
  });

  const leadsData = [
    { nombre: "Luis Garcia", telefono: "555-123-4567", producto: "Seguro de Auto", cantidad: 1, hora: "09:15", categoria: "Salud", status: "NUEVO" },
    { nombre: "Ana Perez", telefono: "555-987-6543", producto: "Laptop Gaming", cantidad: 2, hora: "09:30", categoria: "Tecnologia", status: "NUEVO" },
    { nombre: "Carlos Mendoza", telefono: "555-234-7890", producto: "Servicio de Internet", cantidad: 1, hora: "10:00", categoria: "Tecnologia", status: "SEGUIMIENTO" },
    { nombre: "Maria Lopez", telefono: "555-876-1234", producto: "Perfume Importado", cantidad: 3, hora: "10:15", categoria: "Belleza", status: "NEGOCIACION" },
    { nombre: "Jorge Sanchez", telefono: "555-654-7891", producto: "Plan de Salud", cantidad: 1, hora: "10:45", categoria: "Salud", status: "NUEVO" },
    { nombre: "Saul Perez", telefono: "555-111-3333", producto: "Audifonos Inalambricos", cantidad: 1, hora: "11:00", categoria: "Tecnologia", status: "VENTA", folio: "8564321", monto: 1200 },
  ];

  for (const lead of leadsData) {
    await prisma.lead.create({
      data: { ...lead, vendedorId: vendedor.id },
    });
  }

  console.log("Seed completado:", { admin: admin.email, vendedor: vendedor.email });
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
