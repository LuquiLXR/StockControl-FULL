[OPEN] Debug Session: apk-network-fail

## Síntomas
- En Expo Go: login funciona.
- En APK instalado en dispositivo: al iniciar sesión aparece "Network Request Failed".
- Además, algunos títulos quedan tapados por la barra de estado (hora), no ocurría en Expo Go.

## Hipótesis (falsables)
- A) El APK está usando un `apiBaseUrl` distinto (por ejemplo, fallback a `http://localhost:8080`) por diferencias en `Constants.expoConfig.extra` en release.
- B) El request se bloquea por política de red en Android (cleartext/Network Security) aunque en Expo Go no.
- C) El dispositivo no puede alcanzar el host/puerto (DNS, firewall, red/VPN) y Expo Go estaba llegando por una ruta diferente.
- D) El error proviene de un fallo TLS/handshake/redirect inesperado (si el baseUrl cambia a https o redirige).
- E) El cliente falla antes de enviar la request (URL inválida, encoding, o excepción previa) y se muestra como “Network Request Failed”.

## Evidencia requerida (pre-fix)
- Registrar en runtime (APK) el `apiBaseUrl` real, URL final del login y el error nativo exacto capturado en el catch.
- Registrar conectividad básica `GET /health` desde el mismo cliente del login.
- Registrar detalles de entorno: plataforma, `appOwnership`, valores de `Constants.expoConfig.extra`.

## Plan
1) Iniciar Debug Server en modo `--remote` y configurar URL de recolección de logs.
2) Instrumentar puntos mínimos en `getApiBaseUrl()` y en el flujo de login (antes/después y en catch).
3) Reproducir en APK y analizar logs para confirmar/rechazar hipótesis.
4) Aplicar fix mínimo basado en evidencia.

## Estado
- Debug Server: pendiente
- Instrumentación: pendiente
- RunId: pre-fix pendiente
