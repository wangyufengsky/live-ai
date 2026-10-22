import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { Store } from "../src/store.js";

/** 每个测试文件一个全新的居民（临时数据目录），不碰她本人的数据 */
export function freshStore(): Store {
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-test-"));
  return new Store();
}
