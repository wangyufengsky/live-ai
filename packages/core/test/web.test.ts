/** 打开网页的安全检查：只许公网地址。 */

import { expect, it } from "vitest";
import { checkPublic, htmlToText, isPublic } from "../src/web.js";

it("区分公网和本机 / 局域网 / fake-ip 地址", () => {
  for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700::1111"]) expect(isPublic(ip)).toBe(true);
  for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.1.1", "100.64.0.1", "198.18.0.5", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    expect(isPublic(ip), ip).toBe(false);
  }
});

it("挡住非 http 协议和本机地址", async () => {
  await expect(checkPublic("file:///etc/passwd")).rejects.toThrow("只能打开 http/https");
  await expect(checkPublic("http://127.0.0.1:3000")).rejects.toThrow("本机或局域网");
  await expect(checkPublic("http://[::1]/")).rejects.toThrow("本机或局域网");
});

it("网页转文字：去掉脚本和标签，解码实体", () => {
  const text = htmlToText("<html><head><title>x</title></head><body><script>evil()</script><p>你好&amp;再见</p><div>&#x4e2d;&#25991;</div></body></html>");
  expect(text).not.toContain("evil");
  expect(text).toContain("你好&再见");
  expect(text).toContain("中文");
});
