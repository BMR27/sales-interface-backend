const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function hashKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

async function apiKeyMiddleware(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key) {
    return res.status(401).json({ error: "X-API-Key requerido" });
  }

  try {
    const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: hashKey(key) } });
    if (!apiKey || !apiKey.active) {
      return res.status(401).json({ error: "API key inválida o revocada" });
    }

    req.apiKey = apiKey;
    prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
}

module.exports = { apiKeyMiddleware, hashKey };
