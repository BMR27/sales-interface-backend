# Sales Interface Backend

API REST para Sales Interface. Construido con Node.js, Express, Prisma y PostgreSQL.

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | /api/auth/login | Login de usuario |
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
| GET | /api/productos | Catálogo de productos |
| POST | /api/external/leads | Recepción externa de leads (header `X-API-Key`) |
| GET/POST | /api/admin/* | Panel de administración (resumen, leads, ventas, vendedores) |
| GET/POST/DELETE | /api/admin/api-keys | Gestión de API keys |
| GET | /health | Health check |

## Variables de entorno

```
DATABASE_URL=postgresql://...
JWT_SECRET=...
PORT=3001
FRONTEND_URL=https://tu-frontend.vercel.app
```

## Usuarios (seed)

- Admin: `admin@sales.com` / `admin123`
- Vendedor: `gabriel@sales.com` / `vendedor123` (Gabriel Mendoza)

El seed también limpia cualquier lead/venta/llamada de prueba y carga el catálogo real de productos (Perfect Self 2026 VW, Fase 1).
