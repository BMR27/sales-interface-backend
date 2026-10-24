const jwt = require("jsonwebtoken");
const { setRequestUser } = require("../lib/requestContext");
const { validarSesion } = require("../lib/sesiones");

// Por qué se cayó la sesión, en palabras que se le puedan mostrar a la
// persona. Un 401 pelón se ve como una falla del sistema; esto le dice que
// fue ella quien entró desde otro lado.
const MOTIVOS = {
  otro_inicio: "Tu sesión se cerró porque entraste desde otro dispositivo",
  cerrada_por_usuario: "Tu sesión fue cerrada",
  expirada: "Tu sesión expiró",
  desconocida: "Tu sesión ya no es válida",
};

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token requerido" });
  }

  const token = authHeader.split(" ")[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Token inválido o expirado" });
  }

  if (decoded.rol !== "SUPER_ADMIN" && !decoded.tenantId) {
    return res.status(403).json({ error: "Usuario sin espacio asignado" });
  }

  // El "entrar como" del superadmin no consume ni valida sesión: es una
  // vista prestada de un espacio ajeno y no debe sacar de la aplicación a
  // quien esté trabajando ahí.
  if (!decoded.impersonatedBy) {
    if (!decoded.sid) {
      // Token emitido antes de que existieran las sesiones. Se pide volver
      // a entrar una vez; a partir de ahí todos los tokens llevan `sid`.
      return res.status(401).json({
        error: "Vuelve a iniciar sesión",
        code: "SESION_REQUERIDA",
      });
    }

    const estado = await validarSesion(decoded.sid);
    if (!estado.ok) {
      return res.status(401).json({
        error: MOTIVOS[estado.motivo] || MOTIVOS.desconocida,
        code: "SESION_CERRADA",
        motivo: estado.motivo,
      });
    }
  }

  req.user = decoded;
  setRequestUser(decoded.id, decoded.tenantId ?? null);
  next();
}

module.exports = authMiddleware;
