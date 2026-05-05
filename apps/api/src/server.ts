import './env-loader.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { config } from './config.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './routes/auth.js';
import catalogoRoutes from './routes/catalogo.js';
import ventasRoutes from './routes/ventas.js';
import adminRoutes from './routes/admin.js';
import proveedoresRoutes from './routes/proveedores.js';
import empleadosRoutes from './routes/empleados.js';
import configuracionRoutes from './routes/configuracion.js';
import clientesRoutes from './routes/clientes.js';

const isProd = config.NODE_ENV === 'production';

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport: isProd
        ? undefined
        : {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
    },
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.API_CORS_ORIGINS.split(',').map((o) => o.trim()),
    credentials: true,
  });
  await app.register(cookie, { secret: config.AUTH_SECRET });
  await app.register(sensible);
  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    keyGenerator: (req) => `${req.ip}:${req.routeOptions.url ?? req.url}`,
  });

  // Auth: rate limit más estricto en /auth/login
  app.register(async (loginScope) => {
    await loginScope.register(rateLimit, {
      max: 10,
      timeWindow: '1 minute',
      keyGenerator: (req) => `login:${req.ip}`,
    });
  });

  await app.register(authPlugin);

  app.get('/health', async () => ({
    ok: true,
    name: 'santa-teresita-api',
    version: '0.1.0',
    env: config.NODE_ENV,
    time: new Date().toISOString(),
  }));

  // Rutas montadas bajo /api/v1
  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(catalogoRoutes);
      await api.register(ventasRoutes);
      await api.register(adminRoutes);
      await api.register(proveedoresRoutes);
      await api.register(empleadosRoutes);
      await api.register(configuracionRoutes);
      await api.register(clientesRoutes);
    },
    { prefix: '/api/v1' },
  );

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Validación fallida', issues: err.issues });
    }
    app.log.error(err);
    const e = err as { statusCode?: number; message?: string };
    if (typeof e.statusCode === 'number') {
      return reply
        .code(e.statusCode)
        .send({ error: typeof e.message === 'string' ? e.message : 'Error' });
    }
    return reply.code(500).send({ error: 'Error interno' });
  });

  return app;
}

// Entry point: levantar el server. (Si en el futuro hace falta importar `buildServer`
// desde tests sin auto-arrancar, agregar guard tipo `if (process.env.SKIP_LISTEN !== '1')`).
const app = await buildServer();
try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  app.log.info(
    `🍝 API Santa Teresita escuchando en http://${config.API_HOST}:${config.API_PORT}`,
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
