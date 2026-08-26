// Crea el usuario SUPER_ADMIN inicial (tenantId: null).
// Uso: node scripts/create-superadmin.js <email> <password> <nombre>
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const [, , email, password, nombre] = process.argv;
  if (!email || !password || !nombre) {
    console.error("Uso: node scripts/create-superadmin.js <email> <password> <nombre>");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("La contraseña debe tener al menos 8 caracteres");
    process.exit(1);
  }

  const existente = await prisma.user.findUnique({ where: { email } });
  if (existente) {
    console.error("Ya existe un usuario con ese email");
    process.exit(1);
  }

  const user = await prisma.user.create({
    data: {
      nombre,
      email,
      password: await bcrypt.hash(password, 10),
      rol: "SUPER_ADMIN",
      tenantId: null,
    },
  });

  console.log("SUPER_ADMIN creado:", { id: user.id, email: user.email });
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
