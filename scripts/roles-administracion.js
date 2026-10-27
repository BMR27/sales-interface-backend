// Reparte los dos niveles de administracion sobre las cuentas que ya
// existen, ahora que ADMIN dejo de ser un solo nivel:
//
//   ADMIN            "Super Administrador" -- acceso total al espacio
//   ADMIN_OPERATIVO  "Administrador"       -- sin Equipo, API ni Configuracion
//
// Que hace:
//   1) Baja a Saul y a Karen de ADMIN a ADMIN_OPERATIVO.
//   2) Crea a Silvia como ADMIN_OPERATIVO con una contraseña al azar que
//      imprime una sola vez.
//
// Lo que NO hace: tocar a Bryan ni a Gabriel. Son las dos cuentas con
// acceso total y estan protegidas por nombre aqui abajo -- si el script se
// equivocara al identificar a alguien, el peor caso no puede ser quedarse
// sin ningun administrador pleno.
//
//   node scripts/roles-administracion.js            # solo muestra que haria
//   node scripts/roles-administracion.js --aplicar  # lo ejecuta
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const prisma = new PrismaClient();
const APLICAR = process.argv.includes("--aplicar");

// Se compara sin acentos ni mayusculas: "Saúl" y "SAUL" son la misma persona.
const normalizar = (s) =>
  String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const A_OPERATIVO = ["saul", "karen"];
const INTOCABLES = ["bryan", "gabriel"];

const SILVIA = {
  nombre: "Silvia",
  email: "silvia@perfectself.com.mx",
  rol: "ADMIN_OPERATIVO",
};

// 12 caracteres de entropia real. Se imprime una vez y no se guarda en
// ningun lado: Silvia la cambia desde su perfil al entrar.
function passwordAlAzar() {
  return crypto.randomBytes(9).toString("base64url");
}

(async () => {
  console.log(APLICAR ? "MODO APLICAR\n" : "MODO PRUEBA (nada se escribe). Agrega --aplicar para ejecutar.\n");

  const admins = await prisma.user.findMany({
    where: { rol: { in: ["ADMIN", "ADMIN_OPERATIVO"] } },
    select: { id: true, nombre: true, email: true, rol: true, activo: true, tenantId: true },
    orderBy: { id: "asc" },
  });

  console.log("Administradores actuales:");
  for (const u of admins) {
    console.log(`  #${u.id} ${u.nombre} <${u.email}> ${u.rol}${u.activo ? "" : " (inactivo)"}`);
  }
  console.log("");

  // --- 1) Saul y Karen bajan a ADMIN_OPERATIVO ---
  const aBajar = admins.filter((u) => {
    const n = normalizar(u.nombre);
    if (INTOCABLES.some((p) => n.includes(p))) return false;
    return A_OPERATIVO.some((p) => n.includes(p)) && u.rol === "ADMIN";
  });

  if (aBajar.length === 0) {
    console.log("1) Nadie que bajar a Administrador (o ya estan en ese rol).");
  } else {
    console.log("1) Pasan a ADMIN_OPERATIVO:");
    for (const u of aBajar) console.log(`   #${u.id} ${u.nombre} <${u.email}>`);
    if (APLICAR) {
      await prisma.user.updateMany({
        where: { id: { in: aBajar.map((u) => u.id) } },
        data: { rol: "ADMIN_OPERATIVO" },
      });
      console.log("   -> hecho");
    }
  }

  // Si alguno de los dos no aparecio, hay que decirlo: pudo escribirse
  // distinto en la base y el script lo habria saltado en silencio.
  for (const nombre of A_OPERATIVO) {
    const encontrado = admins.some((u) => normalizar(u.nombre).includes(nombre));
    if (!encontrado) console.log(`   AVISO: no hay ningun administrador cuyo nombre contenga "${nombre}".`);
  }
  console.log("");

  // --- 2) Silvia ---
  const yaExiste = await prisma.user.findUnique({
    where: { email: SILVIA.email },
    select: { id: true, nombre: true, rol: true },
  });

  if (yaExiste) {
    console.log(`2) ${SILVIA.email} ya existe (#${yaExiste.id}, ${yaExiste.rol}).`);
    if (yaExiste.rol !== SILVIA.rol) {
      console.log(`   Se le pondria el rol ${SILVIA.rol}.`);
      if (APLICAR) {
        await prisma.user.update({ where: { id: yaExiste.id }, data: { rol: SILVIA.rol } });
        console.log("   -> hecho");
      }
    }
  } else {
    // El tenant sale del de los administradores que ya hay: crear a Silvia
    // en un espacio equivocado la dejaria viendo datos de otra empresa.
    const tenants = [...new Set(admins.map((u) => u.tenantId).filter(Boolean))];
    if (tenants.length !== 1) {
      console.log(`2) NO se puede crear a Silvia: los administradores estan en ${tenants.length} espacios (${tenants.join(", ")}).`);
      console.log("   Crea la cuenta desde la pantalla de Equipo, que ya sabe en que espacio estas.");
    } else {
      const password = passwordAlAzar();
      console.log(`2) Se crea ${SILVIA.nombre} <${SILVIA.email}> como ${SILVIA.rol} en el espacio ${tenants[0]}.`);
      if (APLICAR) {
        const creada = await prisma.user.create({
          data: {
            nombre: SILVIA.nombre,
            email: SILVIA.email,
            password: await bcrypt.hash(password, 10),
            rol: SILVIA.rol,
            tenantId: tenants[0],
          },
          select: { id: true },
        });
        console.log(`   -> creada (#${creada.id})`);
        console.log("");
        console.log("   ┌──────────────────────────────────────────────────┐");
        console.log("   │ CONTRASEÑA TEMPORAL -- se muestra una sola vez   │");
        console.log(`   │ ${password.padEnd(48)} │`);
        console.log("   └──────────────────────────────────────────────────┘");
        console.log("   Pasasela por un canal privado y que la cambie al entrar.");
      } else {
        console.log("   La contraseña se genera al azar y se imprime al aplicar.");
      }
    }
  }

  console.log("");
  if (!APLICAR) console.log("Nada se escribio. Vuelve a correrlo con --aplicar.");
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error("ERROR:", err.message);
  await prisma.$disconnect();
  process.exit(1);
});
