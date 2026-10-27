-- Rol de administrador de operacion: reparte leads, revisa ventas y mueve
-- inventario, pero no ve Equipo, API ni Configuracion.
--
-- En Postgres, agregar un valor a un enum no puede ir en la misma
-- transaccion que sentencias que lo usen; por eso esta solo en su migracion.
ALTER TYPE "Rol" ADD VALUE IF NOT EXISTS 'ADMIN_OPERATIVO';
