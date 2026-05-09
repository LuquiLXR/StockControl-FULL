# Despliegue de Producción: StockControl

## Objetivo
- Entorno de producción doméstico con servidor Linux y base PostgreSQL, API en contenedor, backups automáticos, seguridad de red mediante túnel, monitoreo básico y pipeline CI/CD.

## Prerrequisitos
- Servidor Linux (Raspberry Pi o PC) con 64-bit y soporte Docker.
- Docker y Docker Compose instalados.
- Acceso al repositorio y secretos (.env).
- Usuario con permisos para manejar contenedores y firewall.

## Variables de Entorno
- Crear archivo `.env` a partir de `infra/env/.env.example` y completar credenciales.
- Variables mínimas:
  - POSTGRES_DB
  - POSTGRES_USER
  - POSTGRES_PASSWORD
  - API_IMAGE

## Puesta en Marcha del Servidor
- Clonar repositorio en el servidor.
- Crear `.env` en `infra/` con valores reales.
- Levantar servicios:
  - `docker compose -f infra/docker-compose.yml --env-file infra/.env up -d`
- Verificar estado:
  - `docker ps`
  - `docker logs stockcontrol-postgres --tail 50`
  - `docker logs stockcontrol-api --tail 50`

## Red y Seguridad
- Mantener la API accesible solo dentro de la red doméstica.
- Configurar túnel seguro (WireGuard/Tailscale-equivalente) para acceso remoto.
- No exponer puertos en internet sin túnel.
- Asegurar firewall con reglas para permitir únicamente tráfico interno y del túnel.

## Backups
- Servicio `pgbackups` genera volcados diarios.
- Ubicación de backups: volumen `pg_backups` dentro del host.
- Procedimiento de restauración:
  - Detener API.
  - Restablecer dump en un contenedor temporal de PostgreSQL.
  - Validar integridad y volver a apuntar la API.

## Monitoreo y Alertas (Base)
- Métricas del sistema y contenedores: configurar Node Exporter y cAdvisor (opcional).
- Logs: centralizar con Loki/Promtail (opcional).
- Alertas: definir al menos alertas de “servicio caído” y “espacio de disco bajo”.
- Visualización: Grafana en la red doméstica.

## CI/CD (Inicial)
- Proceso:
  - Validación de infraestructura (compose).
  - Build y push de imagen de API a registro (GHCR u otro) con secretos.
  - Despliegue en servidor mediante “pull” manual o automatizado por watcher.
- Requerimientos:
  - Registro de contenedores y token de acceso.
  - Claves/secretos en el servicio de CI (Variables/Secrets).

## Pruebas de Carga/Estrés (Plantilla)
- Herramienta sugerida: k6.
- Escenarios:
  - Lecturas concurrentes de inventario.
  - Escrituras de movimientos (ingreso/egreso) con colisiones controladas.
  - Latencia en LAN y bajo túnel.
- Métricas:
  - p95/p99 de latencia.
  - Tasa de errores.
  - Estabilidad bajo reconexión.

## Checklist de Lanzamiento
- `.env` configurado sin secretos por defecto.
- Servicios en `up` y logs sin errores críticos.
- Backups verificados con restauración de prueba.
- Túnel operativo y acceso remoto sin puertos expuestos.
- Monitoreo activo y alertas probadas.
- CI/CD validado con build y publicación de imagen.

## Operación Continua
- Actualizaciones con despliegue rolling de la API.
- Auditoría de dispositivos vinculados y revocación cuando sea necesario.
- Revisión periódica de métricas y capacidad de almacenamiento.
