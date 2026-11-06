import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const windows = process.platform === "win32";
let dir: string;

// serve.ts を置かないので、検証を通っても起動で失敗し、タスクは登録されない。
function install(extra: Record<string, string>) {
  const env: Record<string, string | undefined> = { ...process.env, QUANT: "", PORT: "", SLEEP_IDLE_SECONDS: "", MODELS_DIR: "", ...extra };
  const result = Bun.spawnSync([process.execPath, "autostart.ts", "install"], { cwd: dir, env: env as Record<string, string> });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "autostart-test-"));
  copyFileSync(join(import.meta.dir, "..", "autostart.ts"), join(dir, "autostart.ts"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!windows).each([
  ["PORT", "abc"],
  ["PORT", "0"],
  ["PORT", "65536"],
  ["PORT", "8000 "],
  ["SLEEP_IDLE_SECONDS", "abc"],
  ["SLEEP_IDLE_SECONDS", "0"],
  ["SLEEP_IDLE_SECONDS", "-2"],
  ["SLEEP_IDLE_SECONDS", "1.5"],
  ["MODELS_DIR", "C:/a&b"],
  ["MODELS_DIR", "C:/%TEMP%"],
  ["QUANT", 'Q4"K'],
])("install rejects %s=%s", (name, value) => {
  const { code, output } = install({ [name]: value });
  expect(code).toBe(1);
  expect(output).toContain(`${name} must`);
});

test.skipIf(!windows).each([
  ["PORT", "1"],
  ["PORT", "65535"],
  ["SLEEP_IDLE_SECONDS", "-1"],
  ["SLEEP_IDLE_SECONDS", "300"],
  ["MODELS_DIR", "C:/Program Files (x86)/モデル 置き場"],
])("install accepts %s=%s", (name, value) => {
  expect(install({ [name]: value }).output).not.toContain(" must ");
});
