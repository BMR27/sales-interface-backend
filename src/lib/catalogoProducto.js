// Enlazar un lead con el producto del catálogo.
//
// Un lead trae el producto como TEXTO ("Moviflex"), tal como lo escribió el
// proveedor. El catálogo es otra cosa: la fila con el precio, los
// beneficios y las promociones por volumen. Sin el enlace entre los dos, el
// panel de llamada no tiene nada que dibujar -- ni speech, ni precio, ni
// promociones -- y la vendedora abre la llamada con la pantalla vacía.
//
// Hasta ahora el enlace se intentaba SOLO por `internalSku`:
//
//     const productoCatalogo = internalSku
//       ? await prisma.producto.findFirst({ where: { sku: internalSku } })
//       : null;
//
// Si el proveedor no mandaba SKU -- o mandaba uno que no está en el
// catálogo -- el lead nacía con `productoId: null` aunque su nombre
// coincidiera letra por letra con un producto existente. El resultado era
// una pantalla en blanco por un dato que sí estaba ahí.
//
// Por qué el nombre va al FINAL y sólo con coincidencia exacta: el
// proveedor manda "Prosta Vital Men" donde el catálogo dice "Vital Men
// Balance", así que el nombre no es confiable como primera opción. Y nada
// de coincidencias aproximadas: enlazar el producto equivocado le pondría a
// la vendedora el precio y el speech de otra cosa, que es peor que no
// enlazar nada. Ante la duda, null -- el panel ya sabe decir que hay que
// elegirlo a mano.
const prisma = require("./prisma");

// Para comparar nombres sin que los acentos, los espacios de más o las
// mayúsculas decidan el resultado. "NEUROACTIVE  360" y "Neuroactive 360"
// son el mismo producto escrito por dos personas distintas.
function normalizar(texto) {
  if (typeof texto !== "string") return "";
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Devuelve el producto del catálogo o null. Nunca lanza: un fallo aquí no
// puede impedir que el lead entre -- un lead sin enlazar se puede trabajar,
// un lead perdido no.
async function resolverProducto({ tenantId, internalSku, externalSku, nombre }) {
  if (!tenantId) return null;

  try {
    // 1. El SKU interno es el enlace que el proveedor acordó con nosotros.
    //    Cuando viene y coincide, no hay nada que adivinar.
    if (internalSku) {
      const porSku = await prisma.producto.findFirst({
        where: { sku: String(internalSku).trim(), tenantId },
      });
      if (porSku) return porSku;
    }

    // 2. El SKU del proveedor. Algunos mandan el suyo en el campo que sea,
    //    y a veces coincide con el nuestro.
    if (externalSku) {
      const porExterno = await prisma.producto.findFirst({
        where: { sku: String(externalSku).trim(), tenantId },
      });
      if (porExterno) return porExterno;
    }

    // 3. El nombre, exacto y normalizado. Es el que rescata los leads que
    //    llegan sin SKU, que eran los que acababan con la pantalla vacía.
    const buscado = normalizar(nombre);
    if (!buscado) return null;

    const candidatos = await prisma.producto.findMany({
      where: { tenantId, activo: true },
      select: { id: true, nombre: true, sku: true, producto: true },
    });

    // Se compara contra `nombre` y contra `producto` porque el catálogo
    // guarda los dos y no siempre dicen lo mismo.
    const exacto = candidatos.filter(
      (p) => normalizar(p.nombre) === buscado || normalizar(p.producto) === buscado
    );

    // Dos productos distintos con el mismo nombre normalizado: no hay forma
    // de saber cuál es, y elegir uno al azar le pondría a la vendedora el
    // precio del otro. Se deja sin enlazar, que es honesto.
    if (exacto.length !== 1) return null;

    return prisma.producto.findUnique({ where: { id: exacto[0].id } });
  } catch (err) {
    console.error("no se pudo resolver el producto del catalogo", nombre, err);
    return null;
  }
}

module.exports = { resolverProducto, normalizar };
