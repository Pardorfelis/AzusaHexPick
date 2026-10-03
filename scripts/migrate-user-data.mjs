import { migrateUserData } from '../src/application.mjs';
try {
  if (process.argv.length !== 4) throw new Error();
  const result = await migrateUserData(process.argv[2], process.argv[3]);
  process.stdout.write(JSON.stringify(result));
} catch { process.stderr.write('旧版配置未能导入。原文件保留，请检查选择的目录、现有配置及文件完整性。'); process.exitCode = 1; }
