const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const HERE_REVERSE_URL = "https://revgeocode.search.hereapi.com/v1/revgeocode";
const SEPOMEX_URL = "https://sepomex.kurenn.dev/api/v1/zip_codes";
const USER_AGENT = "VentasCPA-SalesInterface/1.0 (contacto@ventascpa.mx)";
const TIMEOUT_MS = 6000;

function normalizar(texto) {
  return (texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

async function fetchConTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// Coordenadas -> dirección aproximada. OSM da calle y CP con buena
// precisión, pero el número exterior casi nunca: un GPS apunta al predio,
// no a la placa de la casa. Ese campo se deja vacío a propósito en vez de
// inventarlo, porque FullVector lo manda al mensajero tal cual.
async function reverseNominatim(lat, lng) {
  const url = `${NOMINATIM_REVERSE_URL}?lat=${lat}&lon=${lng}&format=json&addressdetails=1&accept-language=es`;
  const resp = await fetchConTimeout(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) return null;

  const data = await resp.json();
  const dir = data?.address;
  if (!dir) return null;

  return {
    calle: dir.road || null,
    numero: dir.house_number || null,
    cp: /^\d{5}$/.test(dir.postcode || "") ? dir.postcode : null,
    colonia: dir.neighbourhood || dir.suburb || dir.quarter || null,
    // En CDMX la alcaldía viene en `borough`; en el resto del país el
    // municipio real es city/town/village.
    municipio: dir.borough || dir.city || dir.town || dir.village || dir.municipality || null,
    estado: dir.state || null,
  };
}

// HERE cubre mucho mejor las calles mexicanas que OSM (en la prueba de
// Cuautitlán dio la calle a 29 m donde OSM no tenía ninguna a 60 m), pero
// sus colonias y CP no cuadran con SEPOMEX: ubica colonias en códigos
// postales a los que no pertenecen. Por eso solo se le toma la calle y,
// como texto a confirmar, la dirección numerada más cercana.
async function reverseHere(lat, lng) {
  const apiKey = process.env.HERE_API_KEY;
  if (!apiKey) return null;

  const url = `${HERE_REVERSE_URL}?at=${lat},${lng}&limit=5&lang=es-MX&apiKey=${apiKey}`;
  const resp = await fetchConTimeout(url);
  if (!resp.ok) return null;

  const data = await resp.json();
  const items = data?.items || [];
  if (items.length === 0) return null;

  const cercano = items[0];
  const conNumero = items.find((i) => i.resultType === "houseNumber" && i.address?.houseNumber);

  return {
    calle: cercano.address?.street || null,
    // Nunca se escribe en shippingNumber: a 29 m de distancia el número
    // puede ser el del vecino o el de la acera de enfrente, donde además
    // suele cambiar la paridad. Va como sugerencia para preguntar.
    sugerencia: conNumero
      ? `${conNumero.address.street} ${conNumero.address.houseNumber} (a ${Math.round(conNumero.distance)} m)`
      : null,
  };
}

// El catálogo de SEPOMEX manda sobre OSM para colonia/municipio/estado:
// son los nombres oficiales que espera la paquetería, no los de OSM.
async function coloniasPorCp(cp) {
  const cacheadas = await prisma.codigoPostal.findMany({ where: { cp } });
  if (cacheadas.length > 0) return cacheadas;

  try {
    const resp = await fetchConTimeout(`${SEPOMEX_URL}?zip_code=${cp}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    const filas = data.zip_codes || [];

    for (const fila of filas) {
      await prisma.codigoPostal.upsert({
        where: { cp_colonia: { cp, colonia: fila.d_asenta } },
        update: {},
        create: {
          cp,
          colonia: fila.d_asenta,
          tipoAsentamiento: fila.d_tipo_asenta,
          municipio: fila.d_mnpio,
          estado: fila.d_estado,
          ciudad: fila.d_ciudad,
        },
      });
    }
    return prisma.codigoPostal.findMany({ where: { cp } });
  } catch (err) {
    console.error("reverseGeocode: SEPOMEX falló para CP", cp, err.message);
    return [];
  }
}

// Devuelve solo lo que se pudo resolver con confianza. Los campos que no,
// quedan null para que la vendedora los pregunte -- es preferible un hueco
// visible a un dato inventado que termine en la guía del mensajero.
async function direccionDesdeCoordenadas(lat, lng) {
  // En paralelo y tolerante a fallos: si uno se cae, el otro todavía sirve.
  const [osmRes, hereRes] = await Promise.allSettled([
    reverseNominatim(lat, lng),
    reverseHere(lat, lng),
  ]);
  const osm = osmRes.status === "fulfilled" ? osmRes.value : null;
  const here = hereRes.status === "fulfilled" ? hereRes.value : null;
  if (hereRes.status === "rejected") {
    console.error("reverseGeocode: HERE falló:", hereRes.reason?.message);
  }
  if (!osm && !here) return null;

  const resultado = {
    // HERE primero: su cobertura de calles en México es muy superior.
    calle: here?.calle || osm?.calle || null,
    numero: osm?.numero || null,
    sugerencia: here?.sugerencia || null,
    cp: osm?.cp || null,
    colonia: null,
    municipio: osm?.municipio || null,
    estado: osm?.estado || null,
  };

  if (!osm || !osm.cp) return resultado;

  const filas = await coloniasPorCp(osm.cp);
  if (filas.length === 0) return resultado;

  // El municipio y el estado son iguales para todo el CP, así que se toman
  // de la primera fila sin riesgo.
  resultado.municipio = filas[0].municipio || resultado.municipio;
  resultado.estado = filas[0].estado || resultado.estado;

  const coincidencia = filas.find((f) => normalizar(f.colonia) === normalizar(osm.colonia));
  if (coincidencia) {
    resultado.colonia = coincidencia.colonia;
  } else if (filas.length === 1) {
    // CP de una sola colonia: no hay ambigüedad posible.
    resultado.colonia = filas[0].colonia;
  }

  return resultado;
}

module.exports = { direccionDesdeCoordenadas };
