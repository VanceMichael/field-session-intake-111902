import { createIntakeService } from './src/intakeService.mjs';

const port = Number(process.env.INTAKE_PORT ?? 3200);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('INTAKE_PORT 应为 1 到 65535 之间的整数');
}
const origin = process.env.SOURCE_ORIGIN ?? 'http://127.0.0.1:3100';
const dataDir = process.env.DATA_DIR ?? new URL('./data', import.meta.url).pathname;

const server = await createIntakeService({ origin, dataDir });
server.listen(port, '127.0.0.1', () => {
  console.log('收件流程已启动 http://127.0.0.1:' + port + ' ，来源 ' + origin + ' ，台账目录 ' + dataDir);
});
