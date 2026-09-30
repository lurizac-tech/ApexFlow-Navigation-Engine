# ApexFlow Distributed

ApexFlow Distributed es un prototipo de arquitectura orientada a microservicios simulados para una clínica dental con API Gateway, autenticación con JWT, scheduling de citas y monitoreo de nodos. El sistema está implementado como una aplicación Node.js + Express que expone una API REST y un frontend estático, además de un modelo de ejecución distribuida basado en `worker_threads` para pruebas de carga y observabilidad.

## 1. Arquitectura distribuida

### Componentes

- Frontend web: archivos estáticos en `public/` servidos por Express.
- API Gateway: `src/server.js` actúa como punto de entrada central para la API REST y el dashboard de métricas.
- Autenticación: JWT emitido por `/api/auth/login` y validado por middleware.
- Servicio de citas: lógica para crear, consultar, cancelar y programar citas por doctor/fecha/hora.
- Worker pool: `src/worker.js` utiliza `worker_threads` para procesar tareas asíncronas en paralelo.
- Monitor de salud: endpoints de `/health` y `/api/metrics` para observar latencia, uso de memoria, worker threads y carga simulada.
- Despliegue cloud: configuración de `render.yaml` para desplegar el servicio en Render con health check.

### Flujo de operación

1. El usuario accede a la interfaz web desde el navegador.
2. El frontend realiza login con credenciales demo y recibe un JWT.
3. La API Gateway valida el token y autoriza las siguientes llamadas.
4. El servicio de citas valida disponibilidad, reserva la cita y encola trabajos para notificaciones.
5. Los jobs se procesan mediante `worker_threads` en paralelo.
6. La API expone métricas de latencia, throughput y estado del nodo para benchmarking.

### Secuencia multihilo

```text
Cliente web
   | 
   v
API Gateway (Express)
   |  -- valida JWT --> auth middleware
   |  -- reserva cita --> servicio de citas
   |  -- encola jobs --> queue
   v
Worker Threads (Node.js)
   |  -- procesa email / notificación / tareas async --> completed
   v
Observabilidad / Metrics
   |  -- p95, success rate, latency, node status --> dashboard
   v
Cloud / Render
```

### Despliegue cloud

La configuración `render.yaml` define un servicio web y una instancia PostgreSQL de Render. Al crear el Blueprint, Render enlaza la base mediante `DATABASE_URL` y genera `JWT_SECRET`; no es necesario guardar credenciales de producción en el repositorio.

- comando de build: `npm ci --omit=dev`
- comando de inicio: `npm start`
- health check: `/health`
- PostgreSQL administrado, inicialización automática de tablas y datos demo
- variables de entorno: `NODE_ENV`, `JWT_SECRET`, `JWT_EXPIRES_IN` y `DATABASE_URL`

Render proporciona `PORT` automáticamente. En producción, la aplicación no inicia si PostgreSQL o `JWT_SECRET` no están disponibles, y `/health` devuelve HTTP 503 si la base deja de responder. Para desplegar, conecta el repositorio en Render y crea los recursos definidos en el Blueprint `render.yaml`.

## 2. Requisitos

- Node.js 20.x recomendado
- npm 10.x
- Git

## 3. Instalación local

Clona el repositorio y entra al proyecto:

```bash
git clone https://github.com/lurizac-tech/apexflow-distributed.git
cd apexflow-distributed
```

Instala dependencias:

```bash
npm install
```

Para usar PostgreSQL local, copia `.env.example` a `.env` y adapta `DATABASE_URL`, `JWT_SECRET` y `PORT` a tu entorno.

Ejecuta la aplicación:

```bash
npm start
```

Modo desarrollo:

```bash
npm run dev
```

La API queda disponible en:

- Frontend: http://localhost:3000
- Health endpoint: http://localhost:3000/health

## 4. Credenciales demo

```text
Administrador:
email: admin@apexflow.com
password: admin123

Paciente:
email: paciente@apexflow.com
password: paciente123

Dentista:
email: dentista@apexflow.com
password: dentista123
```

## 5. Endpoints y métricas de rendimiento

| Método | Endpoint | Descripción |
|---|---|---|
| GET | `/health` | Estado general del gateway y del sistema |
| POST | `/api/auth/login` | Emite JWT de sesión |
| GET | `/api/auth/me` | Devuelve el usuario autenticado |
| GET | `/api/metrics` | Métricas de nodos, memoria, worker threads y estado de carga |
| POST | `/api/load-test` | Ejecuta un escenario de carga simulado con latencia p95 |
| GET | `/api/jobs` | Estado de la cola de trabajos y workers |
| GET | `/api/notifications` | Últimas notificaciones generadas |
| GET | `/api/citas` | Lista citas registradas |
| POST | `/api/citas` | Reserva una cita con validación de disponibilidad |
| PATCH | `/api/citas/:id/cancelar` | Cancela una cita |

### Métricas relevantes

- `p95MaxMs`: latencia p95 máxima del escenario de prueba de carga
- `interNodeLatencyAvgMs`: latencia promedio de comunicación entre nodos
- `successRate`: porcentaje de peticiones exitosas
- `workerThreads`: cantidad de hilos activos en la simulación
- `memory`: consumo de memoria del proceso Node.js

## 6. Ejecución de pruebas de carga

Se incluye un benchmark simple en Node.js para ejecutar 100 peticiones concurrentes:

```bash
node tests/benchmark.js http://localhost:3000
```

También puedes usar variables de entorno:

```bash
APEXFLOW_URL=http://localhost:3000 node tests/benchmark.js
BENCHMARK_REQUESTS=100 BENCHMARK_CONCURRENCY=10 node tests/benchmark.js
```

El script:

- autentica con credenciales demo
- obtiene un JWT
- ejecuta peticiones concurrentes a `/api/metrics`
- calcula promedio, mínimo, máximo y percentil p95
- imprime el resultado por consola

## 7. Estructura del repositorio

```text
apexflow-distributed/
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── src/
│   ├── server.js
│   ├── worker.js
│   └── db.js
├── tests/
│   ├── api.admin.test.js
│   └── benchmark.js
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── render.yaml
├── README.md
└── LICENSE (si aplica)
```

## 8. Observaciones

- El sistema simula una arquitectura distribuida con un gateway central y workers paralelos.
- La lógica de pruebas de rendimiento no requiere infraestructura externa; usa el propio servidor local o una URL cloud.
- El benchmark es útil para validar la capacidad del servicio y comparar latencias bajo picos de carga.

## 9. Licencia

Este proyecto es un prototipo académico y de demostración. Consulta el archivo de licencia del repositorio si se aplica.
