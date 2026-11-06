// Numeros que no se deben volver a contactar, y la deteccion de repetidos.
//
// Son dos cosas distintas que la gente junta en la misma frase
// ("blacklist") y conviene no confundir:
//
//   DUPLICADO   el mismo cliente entro dos veces. Es un cobro de mas del
//               proveedor y una llamada de mas al cliente. Se detecta
//               solo, comparando la base contra si misma.
//   BLOQUEADO   alguien decidio que a ese numero no se le vuelve a
//               llamar. No se deduce de nada: es una decision que una
//               persona toma y que hay que registrar.
//
// Hasta ahora el motivo de descarte BLACKLIST existia pero no habia donde
// guardar la lista, asi que marcarlo era una observacion suelta de la
// vendedora: el mismo numero volvia a entrar al dia siguiente y nadie se
// enteraba. Esto es el catalogo que faltaba.

// La clave con la que se comparan dos telefonos.
//
// Se usan los ULTIMOS 10 DIGITOS y no el texto completo: el mismo numero
// llega escrito de maneras distintas segun quien lo mande
// ("+524151026124", "524151026124", "4151026124", "415 102 6124"), y
// compararlos como texto los trata como cuatro numeros diferentes. Diez
// digitos es el largo nacional en Mexico; la lada de pais se descarta
// justamente porque es la parte que cambia de forma.
//
// El limite conocido: un numero extranjero de mas de 10 digitos podria
// colisionar con uno nacional que termine igual. La operacion es nacional,
// asi que se asume; si algun dia deja de serlo, hay que guardar tambien el
// pais y comparar por el par.
function claveTelefono(telefono) {
  const digitos = String(telefono || "").replace(/\D/g, "");
  if (!digitos) return "";
  return digitos.length > 10 ? digitos.slice(-10) : digitos;
}

// Para comparar nombres sin que los acentos, los espacios de mas o las
// mayusculas decidan el resultado. Mismo criterio que el enlace de
// productos: "MARIO  LOPEZ" y "Mario López" son la misma persona escrita
// por dos capturistas distintos.
function claveNombre(nombre) {
  if (typeof nombre !== "string") return "";
  return nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ¿Este telefono esta en la lista de bloqueados de esta empresa?
// Devuelve el registro (para poder decir por que) o null.
//
// Nunca lanza: si la consulta falla, el lead entra. Perder un lead porque
// la revision de blacklist tuvo un error es peor que dejar pasar uno que
// debio bloquearse -- lo segundo se corrige despues, lo primero no se
// entera nadie.
async function buscarBloqueo(prisma, tenantId, telefono) {
  const clave = claveTelefono(telefono);
  if (!clave || !tenantId) return null;
  try {
    return await prisma.numeroBloqueado.findUnique({
      where: { tenantId_telefono: { tenantId, telefono: clave } },
    });
  } catch (err) {
    console.error("no se pudo revisar la lista de bloqueados", err);
    return null;
  }
}

module.exports = { claveTelefono, claveNombre, buscarBloqueo };
