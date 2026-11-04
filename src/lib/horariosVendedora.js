// El turno de una vendedora: cuando se le puede dar trabajo.
//
// Lo usa una sola regla, pero es la que decide a donde va el lead. Cuando
// el cliente pide que le llamen hoy mas tarde:
//
//   la hora cae DENTRO de su turno  -> el lead se queda con ella
//   la hora cae FUERA de su turno   -> vuelve a la coordinadora
//   no tiene turno configurado      -> vuelve a la coordinadora, marcado
//
// El tercer caso es deliberado y no es un error: prometerle al cliente una
// llamada a las 8 de la noche dejandosela a alguien de quien no sabemos si
// trabaja a esa hora es peor que pasarla a quien si puede decidir. El lead
// va marcado con `requiereRevisionHorario` para que la coordinadora sepa
// que lo que falta es configuracion, no atencion.
//
// Las horas se guardan en MINUTOS desde medianoche (0..1439), no como
// fechas: un turno no es un instante sino una franja que se repite. El dia
// de la semana y la hora de una fecha concreta se leen SIEMPRE en la zona
// de la operacion (ver fechasLocales.js) -- el servidor corre en UTC y
// `getDay()` cambiaria de dia a las 18:00, con lo que un sabado por la
// noche contaria como domingo.
const prisma = require("./prisma");
const { enHusoLocal } = require("./fechasLocales");

const MINUTOS_DIA = 24 * 60;

const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

// El dia de la semana (0..6) y el minuto del dia (0..1439) de un instante,
// vistos desde la operacion.
function momentoLocal(fecha) {
  const local = enHusoLocal(fecha);
  return {
    diaSemana: local.getUTCDay(),
    minuto: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

// "9:30" a partir de 570. Para los mensajes que lee la coordinadora.
function formatearMinuto(minutos) {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  const sufijo = h < 12 ? "a.m." : "p.m.";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${sufijo}`;
}

// Valida un rango antes de guardarlo. Un turno invertido (19:00 a 9:00) no
// se rechaza por capricho: significaria un turno que cruza la medianoche, y
// esta operacion no los tiene. Aceptarlo en silencio haria que ninguna hora
// cayera "dentro" y todas las rellamadas se fueran a la coordinadora sin
// que nadie entendiera por que.
function validarRango({ diaSemana, horaInicio, horaFin }) {
  const dia = Number(diaSemana);
  const inicio = Number(horaInicio);
  const fin = Number(horaFin);

  if (!Number.isInteger(dia) || dia < 0 || dia > 6) {
    return { error: "El día de la semana debe ir de 0 (domingo) a 6 (sábado)" };
  }
  if (!Number.isInteger(inicio) || inicio < 0 || inicio >= MINUTOS_DIA) {
    return { error: "Hora de inicio inválida" };
  }
  if (!Number.isInteger(fin) || fin <= 0 || fin > MINUTOS_DIA) {
    return { error: "Hora de fin inválida" };
  }
  if (fin <= inicio) {
    return { error: `${DIAS[dia]}: la hora de fin debe ser posterior a la de inicio` };
  }
  return { valor: { diaSemana: dia, horaInicio: inicio, horaFin: fin } };
}

// Los turnos de una vendedora, agrupados por dia. Devuelve [] cuando no
// tiene ninguno, que es lo que significa "sin configurar".
async function horariosDe(userId, tenantId) {
  if (!userId || !tenantId) return [];
  return prisma.horarioVendedora.findMany({
    where: { userId, tenantId },
    orderBy: [{ diaSemana: "asc" }, { horaInicio: "asc" }],
  });
}

// ¿Esta vendedora trabaja en este momento?
//
// Devuelve un objeto y no un boolean porque las tres respuestas posibles no
// son dos: "si", "no" y "no se sabe". Quien llama tiene que distinguir la
// tercera -- es la que manda el lead a la coordinadora marcado.
//
//   { configurado: false }                     -> no tiene turnos
//   { configurado: true, dentro: true,  ... }  -> dentro del turno
//   { configurado: true, dentro: false, ... }  -> fuera del turno
function evaluarTurno(horarios, fecha = new Date()) {
  if (!Array.isArray(horarios) || horarios.length === 0) {
    return { configurado: false, dentro: false, motivo: "Esta vendedora no tiene horario configurado" };
  }

  const { diaSemana, minuto } = momentoLocal(fecha);
  const delDia = horarios.filter((h) => h.diaSemana === diaSemana);

  if (delDia.length === 0) {
    return {
      configurado: true,
      dentro: false,
      motivo: `No trabaja los ${DIAS[diaSemana].toLowerCase()}`,
    };
  }

  // El fin es exclusivo: un turno que termina a las 19:00 no cubre las
  // 19:00. Prometer una llamada justo en el minuto en que alguien se va es
  // prometerla a nadie.
  const franja = delDia.find((h) => minuto >= h.horaInicio && minuto < h.horaFin);
  if (franja) {
    return { configurado: true, dentro: true, franja };
  }

  const texto = delDia.map((h) => `${formatearMinuto(h.horaInicio)} a ${formatearMinuto(h.horaFin)}`).join(" y ");
  return {
    configurado: true,
    dentro: false,
    motivo: `Su turno del ${DIAS[diaSemana].toLowerCase()} es de ${texto}`,
  };
}

// Lo mismo, resolviendo los horarios desde la base. Es el atajo que usan
// las rutas.
async function evaluarTurnoDe(userId, tenantId, fecha = new Date()) {
  return evaluarTurno(await horariosDe(userId, tenantId), fecha);
}

// El siguiente instante hábil a partir de `desde`, mirando los turnos dados.
//
// Lo pide el protocolo: si la proxima disponibilidad de un lead cae fuera
// del horario operativo, hay que mantener el intervalo minimo pero mostrar
// el siguiente turno hábil, y no exigirle a nadie llamar fuera de su turno.
//
// Devuelve null si no hay turnos o si no se encuentra ninguno en una
// semana -- el limite existe para no girar para siempre con una
// configuracion imposible (todos los dias con el mismo rango vacio).
function siguienteInicioHabil(horarios, desde = new Date()) {
  if (!Array.isArray(horarios) || horarios.length === 0) return null;

  const { diaSemana, minuto } = momentoLocal(desde);

  for (let salto = 0; salto < 8; salto++) {
    const dia = (diaSemana + salto) % 7;
    const delDia = horarios.filter((h) => h.diaSemana === dia).sort((a, b) => a.horaInicio - b.horaInicio);

    for (const franja of delDia) {
      // Hoy: solo sirve una franja que todavia no termina. Si ya estamos
      // dentro de ella, el instante habil es AHORA, no el inicio del turno.
      if (salto === 0) {
        if (minuto < franja.horaInicio) {
          return new Date(desde.getTime() + (franja.horaInicio - minuto) * 60000);
        }
        if (minuto < franja.horaFin) return new Date(desde.getTime());
        continue;
      }
      // Otro dia: el inicio de la primera franja de ese dia.
      const minutosHasta = salto * MINUTOS_DIA - minuto + franja.horaInicio;
      return new Date(desde.getTime() + minutosHasta * 60000);
    }
  }

  return null;
}

module.exports = {
  DIAS,
  MINUTOS_DIA,
  momentoLocal,
  formatearMinuto,
  validarRango,
  horariosDe,
  evaluarTurno,
  evaluarTurnoDe,
  siguienteInicioHabil,
};
