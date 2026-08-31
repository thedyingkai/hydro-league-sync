import { createHubApplication } from './app.js';

const { app, options } = createHubApplication();

try {
  const address = await app.listen({ host: options.host, port: options.port });
  process.stdout.write(`Hydro League Hub listening at ${address}\n`);
  if (!options.adminToken) process.stderr.write('Admin API is disabled because HYDRO_LEAGUE_ADMIN_TOKEN is not set\n');
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
