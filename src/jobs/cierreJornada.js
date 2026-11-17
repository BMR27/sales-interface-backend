// Cierra la jornada: genera los tickets de comisión del día.
//
// Un ticket es la foto de lo que una vendedora aportó ese día al
// acumulado de su quincena (ver src/lib/ticketsComision.js). Existe para
// que haya algo que revisar y firmar, en vez de una cifra viva que cambia
// sola y que nadie puede dar por buena.
//
// Corre cada hora y no una sola vez al día a propósito. La jornada no
// termina a la misma hora para todas, las entregas se confirman tarde, y
// un servicio que se reinició justo a la hora del cierre se habría
// saltado el día entero. Como `generarTicket` actualiza el ticket del día
// mientras siga en aprobación y no lo toca en cuanto alguien lo aprobó,
// repetir la corrida no duplica nada ni reescribe lo ya revisado.
const prisma = require("../lib/prisma");
const { generarTicketsDelDia } = require("../lib/ticketsComision");

const INTERVAL_MS = 60 * 60 * 1000;

async function cerrarJornadas() {
  try {
    const tenants = await prisma.tenant.findMany({
      where: { status: "ACTIVO" },
      select: { id: true },
    });

    for (const t of tenants) {
      try {
        const tickets = await generarTicketsDelDia(t.id);
        if (tickets.length > 0) {
          console.log(`cierre de jornada: ${tickets.length} tickets de comisión en el espacio ${t.id}`);
        }
      } catch (err) {
        // Un espacio que falla no puede dejar sin cerrar a los demás.
        console.error("cierre de jornada: fallo en el espacio", t.id, err);
      }
    }
  } catch (err) {
    console.error("cierre de jornada: no se pudo listar los espacios", err);
  }
}

function startCierreJornadaJob() {
  // La primera corrida se retrasa un minuto para no competir con el
  // arranque: al levantar el servicio hay migraciones y conexiones que
  // atender antes que esto.
  setTimeout(() => {
    cerrarJornadas();
    setInterval(cerrarJornadas, INTERVAL_MS);
  }, 60 * 1000);
}

module.exports = { startCierreJornadaJob, cerrarJornadas };
