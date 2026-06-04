import { execSync } from 'child_process';

try {
  execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  process.exit(0);
} catch {
  process.exit(1);
}
