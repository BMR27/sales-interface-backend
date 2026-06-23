# Sales Interface Backend

API REST para Sales Interface. Construido con Node.js, Express, Prisma y PostgreSQL.

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | /api/auth/login | Login de usuario |
| POST | /api/auth/register | Registro de usuario |
| GET | /api/dashboard | Métricas del día + leads |
| GET | /api/leads | Lista de leads |
| POST | /api/leads | Crear lead |
| PUT | /api/leads/:id | Actualizar lead |
| DELETE | /api/leads/:id | Archivar lead |
| GET | /api/llamada/:id | Info del lead para llamada |
| POST | /api/llamada/:id/confirmar | Registrar resultado de llamada |
| GET | /api/ganancias | Resumen de ganancias |
| POST | /api/ganancias/venta | Registrar venta cerrada |
| GET | /api/configuracion | Perfil del usuario |
| PUT | /api/configuracion | Actualizar perfil |
| GET | /health | Health check |

## Variables de entorno

```
DATABASE_URL=postgresql://...
JWT_SECRET=...
PORT=3001
FRONTEND_URL=https://tu-frontend.vercel.app
```

## Usuarios de prueba (seed)

- Admin: `admin@sales.com` / `admin123`
- Vendedor: `juan@sales.com` / `vendedor123`
