const { PrismaClient } = require("@prisma/client");
const { isEnabled, syncVentaToFullVector } = require("../lib/fullvector");

const prisma = new PrismaClient();

const INTERVAL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;

// El estado vive en la tabla Venta (no en memoria), así que un reinicio del
// proceso (deploy) no pierde ningún pendiente -- el próximo tick lo recoge.
function startFullvectorRetryJob() {
  if (!isEnabled()) return;

  setInterval(async () => {
    const pendientes = await prisma.venta.findMany({
      where: { fullvectorSyncStatus: "PENDING", fullvectorAttempts: { lt: MAX_ATTEMPTS } },
      take: 20,
    });
    for (const venta of pendientes) {
      await syncVentaToFullVector(venta.id).catch((err) => {
        console.error("fullvector retry error, venta", venta.id, err);
      });
    }
  }, INTERVAL_MS);
}

module.exports = { startFullvectorRetryJob };
