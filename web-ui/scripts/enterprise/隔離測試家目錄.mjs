// 僅供合成測試：隔離 os.homedir()，不改使用者 HOME 或產品程式。
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
if (!process.env.DHC_TEST_ROOT || !path.isAbsolute(process.env.DHC_TEST_ROOT)) {
  throw new Error('DHC_TEST_ROOT 必須是測試專用絕對路徑');
}
const nativeHomeDirectory = os.homedir;
const temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
// 上游測試會自行切換到另一個 mkdtemp 家目錄，保留該測試行為。
os.homedir = () => {
  const candidate = nativeHomeDirectory();
  return path.resolve(candidate).startsWith(temporaryRoot) ? candidate : process.env.DHC_TEST_ROOT;
};
syncBuiltinESMExports();
