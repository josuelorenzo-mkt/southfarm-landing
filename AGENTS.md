<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Regla de entregas (definida por el dueño, 2026-08-20)

Cada vez que se entrega una versión funcional de una tarea grande (algo que el dueño puede probar/navegar), se hace un **commit inmediato en el/los repos correspondientes** ANTES de avanzar con la siguiente iteración. Ojo con el repo anidado: `webapp/` tiene su propio git y requiere commit separado. Nunca entregar una versión que solo exista en el working tree.
