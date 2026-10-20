const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
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
  const osm = await reverseNominatim(lat, lng);
  if (!osm) return null;

  const resultado = {
    calle: osm.calle,
    numero: osm.numero,
    cp: osm.cp,
    colonia: null,
    municipio: osm.municipio,
    estado: osm.estado,
  };

  if (!osm.cp) return resultado;

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
