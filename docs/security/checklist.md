# Checklist de Seguridad para Producción

- Credenciales únicas y fuertes en `.env` sin valores por defecto.
- Base de datos sin exposición pública de puertos.
- Acceso remoto mediante túnel seguro configurado y verificado.
- Dispositivos enrolados con identificación y posibilidad de revocación.
- Backups diarios probados con restauración de ensayo.
- Logs sin datos sensibles y con rotación adecuada.
- Firewall del servidor con reglas mínimas necesarias.
- Actualizaciones periódicas de contenedores y sistema operativo.
- Auditoría básica de accesos y cambios.
