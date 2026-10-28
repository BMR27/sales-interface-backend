// Folio interno: "PS-000123".
//
// Existe porque el nombre del cliente no sirve para referirse a un lead --
// llega mal capturado desde el proveedor ("Josemoralestrujillo", "J.lionso.
// Rodriguez Ibarra De Lomita...") -- y el folio del proveedor no lo
// controlamos nosotros ni es unico.
//
// Se dicta por telefono, asi que es corto y sin ambiguedad: solo digitos
// despues del prefijo, nada de letras que se confundan al oido.
const prisma = require("./prisma");

const PREFIJO = "PS";
const DIGITOS = 6;

function formatear(valor) {
  return `${PREFIJO}-${String(valor).padStart(DIGITOS, "0")}`;
}

// El consecutivo se reserva con UNA sentencia que incrementa y devuelve a la
// vez. Es lo que impide que dos leads que entran al mismo tiempo lean el
// mismo numero: calcularlo con un max(folioPS) o con leer-luego-escribir
// daria el mismo valor a los dos y uno fallaria contra el indice unico.
//
// `ON CONFLICT` cubre el primer lead de un espacio sin tener que sembrar la
// fila por separado.
async function siguienteFolio(tenantId, cliente = prisma) {
  if (!tenantId) return null;

  const filas = await cliente.$queryRaw`
    INSERT INTO folio_contadores ("tenantId", valor)
    VALUES (${tenantId}, 1)
    ON CONFLICT ("tenantId") DO UPDATE SET valor = folio_contadores.valor + 1
    RETURNING valor
  `;

  const valor = filas?.[0]?.valor;
  return Number.isFinite(Number(valor)) ? formatear(Number(valor)) : null;
}

// Asigna folio a un lead que no lo tiene. Nunca lanza: un fallo aqui no
// puede impedir que el lead entre -- un lead sin folio se puede rellenar
// despues, un lead perdido no se recupera.
async function asignarFolio(leadId, tenantId) {
  try {
    const folioPS = await siguienteFolio(tenantId);
    if (!folioPS) return null;
    await prisma.lead.update({ where: { id: leadId }, data: { folioPS } });
    return folioPS;
  } catch (err) {
    console.error("no se pudo asignar folio interno al lead", leadId, err);
    return null;
  }
}

module.exports = { PREFIJO, formatear, siguienteFolio, asignarFolio };
