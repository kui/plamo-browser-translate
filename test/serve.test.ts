import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

// Windows では PowerShell の起動だけで数秒かかる。
setDefaultTimeout(120_000);
process.env.NO_PROXY = "127.0.0.1";

const exe = process.platform === "win32" ? ".exe" : "";
let root: string;
let binDir: string;
let home: string;
let port: string;
let foreign: ReturnType<typeof Bun.serve> | undefined;

function makeCheckout(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(import.meta.dir, "..", "serve.ts"), join(dir, "serve.ts"));
  return dir;
}

function writeModel(modelsDir: string) {
  const model = join(modelsDir, "plamo-3-translate-2b-GGUF");
  mkdirSync(model, { recursive: true });
  writeFileSync(join(model, "plamo-3-translate-2b-Q4_K_M.gguf"), "");
  writeFileSync(join(model, "chat_template.jinja"), "");
}

function environment(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toUpperCase() !== "PATH") env[key] = value;
  }
  const inherited = process.env.PATH ?? process.env.Path ?? "";
  return { ...env, PATH: binDir + delimiter + inherited, HOME: home, USERPROFILE: home, PORT: port, ...extra };
}

async function serve(dir: string, args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, "serve.ts", ...args], {
    cwd: dir,
    env: environment(extra),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, output: stdout + stderr };
}

async function health(): Promise<number | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return response.status;
  } catch {
    return undefined;
  }
}

const stateFile = () => join(home, ".cache", "plamo-browser-translate", `${port}.json`);
const logFile = () => join(home, ".cache", "plamo-browser-translate", `${port}.log`);
const modelsDir = () => join(home, ".cache", "plamo-browser-translate", "models");

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "serve-test-"));
  binDir = join(root, "bin");
  const build = Bun.spawnSync([
    process.execPath, "build", "--compile", join(import.meta.dir, "fake-llama-server.ts"),
    "--outfile", join(binDir, `llama-server${exe}`),
  ], { stderr: "inherit" });
  expect(build.exitCode).toBe(0);
  copyFileSync(join(binDir, `llama-server${exe}`), join(binDir, `uvx${exe}`));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  home = mkdtempSync(join(root, "home-"));
  writeModel(modelsDir());
  const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  port = String(free.port);
  void free.stop(true);
});

afterEach(async () => {
  void foreign?.stop(true);
  foreign = undefined;
  if (existsSync(stateFile())) {
    const { pid } = JSON.parse(readFileSync(stateFile(), "utf8"));
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // すでに終了している。
      }
      await Bun.sleep(300);
    }
  }
  rmSync(home, { recursive: true, force: true });
});

test("start waits for the server and stop removes it", async () => {
  const dir = makeCheckout("a");
  const started = await serve(dir, ["start"], { FAKE_LOAD_MS: "1500" });
  expect(started.output).toContain("Waiting for the server");
  expect(started.output).toContain("Listening on");
  expect(started.code).toBe(0);
  expect(await health()).toBe(200);
  expect(readFileSync(logFile(), "utf8")).toContain("fake llama-server started");

  const stopped = await serve(dir, ["stop"]);
  expect(stopped.output).toContain("Stopped");
  expect(stopped.code).toBe(0);
  expect(await health()).toBeUndefined();
  expect(existsSync(stateFile())).toBe(false);

  const again = await serve(dir, ["stop"]);
  expect(again.output).toContain("Not running");
  expect(again.code).toBe(0);
});

// bun から直接呼ぶパイプでは、サーバーがパイプを握る不具合が再現しない。シェルのパイプラインを通す。
test("a shell pipeline ends while the server keeps running", async () => {
  const dir = makeCheckout("a");
  const pipeline = process.platform === "win32"
    ? ["cmd", "/c", "bun serve.ts start | findstr ."]
    : ["sh", "-c", "bun serve.ts start | cat"];
  const proc = Bun.spawn(pipeline, {
    cwd: dir,
    env: environment({ PATH: binDir + delimiter + dirname(process.execPath) + delimiter + (process.env.PATH ?? process.env.Path ?? "") }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = new Response(proc.stdout).text();
  const ended = await Promise.race([proc.exited.then(() => true), Bun.sleep(30_000).then(() => false)]);
  if (!ended) proc.kill("SIGKILL");
  expect(ended).toBe(true);
  expect(await output).toContain("Listening on");
  expect(await health()).toBe(200);
});

test("a second start reports the same server", async () => {
  const dir = makeCheckout("a");
  const first = await serve(dir, ["start"]);
  const second = await serve(dir, ["start"]);
  expect(second.code).toBe(0);
  const pid = (output: string) => /Listening on .*\(pid (\d+)\)/.exec(output)?.[1];
  expect(pid(second.output)).toBe(pid(first.output));
  expect(pid(second.output)).toBeDefined();
});

test("a second start waits while the server is loading", async () => {
  const dir = makeCheckout("a");
  const first = Bun.spawn([process.execPath, "serve.ts", "start"], {
    cwd: dir, env: environment({ FAKE_LOAD_MS: "4000" }), stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  while (!existsSync(stateFile()) || !readFileSync(stateFile(), "utf8").includes("pid")) await Bun.sleep(50);
  first.kill("SIGKILL");
  await first.exited;

  const second = await serve(dir, ["start"]);
  expect(second.code).toBe(0);
  expect(await health()).toBe(200);
});

test("start refuses other settings while running", async () => {
  const dir = makeCheckout("a");
  await serve(dir, ["start"]);
  const other = await serve(dir, ["start", "8b"]);
  expect(other.code).toBe(1);
  expect(other.output).toContain("run stop first");
  expect(await health()).toBe(200);
});

test("concurrent starts leave one server that stop can remove", async () => {
  const dir = makeCheckout("a");
  const results = await Promise.all([serve(dir, ["start"]), serve(dir, ["start"]), serve(dir, ["start"])]);
  expect(results.filter((result) => result.code !== 0)).toEqual([]);
  const pids = results.map((result) => /pid (\d+)/.exec(result.output.split("\n").at(-2)!)![1]);
  expect(new Set(pids).size).toBe(1);

  await serve(dir, ["stop"]);
  expect(await health()).toBeUndefined();
});

test("concurrent starts over a stale state file leave one server", async () => {
  const dir = makeCheckout("a");
  mkdirSync(join(home, ".cache", "plamo-browser-translate"), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify({ pid: process.pid, size: "2b", quant: "Q4_K_M" }));
  const results = await Promise.all([serve(dir, ["start"]), serve(dir, ["start"]), serve(dir, ["start"])]);
  expect(results.filter((result) => result.code !== 0)).toEqual([]);

  await serve(dir, ["stop"]);
  expect(await health()).toBeUndefined();
});

test("another checkout can stop the server, even after the first is removed", async () => {
  const first = makeCheckout("first");
  const second = makeCheckout("second");
  await serve(first, ["start"]);
  rmSync(first, { recursive: true, force: true });

  expect((await serve(second, ["start"])).code).toBe(0);
  const stopped = await serve(second, ["stop"]);
  expect(stopped.output).toContain("Stopped");
  expect(await health()).toBeUndefined();
});

test("each port has its own server", async () => {
  const dir = makeCheckout("a");
  await serve(dir, ["start"]);
  const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const otherPort = String(free.port);
  void free.stop(true);

  const other = await serve(dir, ["start"], { PORT: otherPort });
  expect(other.code).toBe(0);
  expect(other.output).toContain(`127.0.0.1:${otherPort}`);
  expect((await serve(dir, ["stop"], { PORT: otherPort })).code).toBe(0);
  expect(await health()).toBe(200);
});

test("a stale state file does not stop start or kill the other process", async () => {
  const dir = makeCheckout("a");
  mkdirSync(join(home, ".cache", "plamo-browser-translate"), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify({ pid: process.pid, size: "2b", quant: "Q4_K_M" }));
  const stopped = await serve(dir, ["stop"]);
  expect(stopped.output).toContain("Not running");
  expect(existsSync(stateFile())).toBe(false);

  writeFileSync(stateFile(), JSON.stringify({ pid: process.pid, size: "8b", quant: "Q4_K_M" }));
  expect((await serve(dir, ["start"])).code).toBe(0);
  expect(await health()).toBe(200);
});

test("a broken state file is treated as no server", async () => {
  const dir = makeCheckout("a");
  mkdirSync(join(home, ".cache", "plamo-browser-translate"), { recursive: true });
  writeFileSync(stateFile(), "garbage");
  const stopped = await serve(dir, ["stop"]);
  expect(stopped.output).toContain("Not running");
  expect(existsSync(stateFile())).toBe(false);
});

test("start reports a port held by another server and stop does not claim it is free", async () => {
  const dir = makeCheckout("a");
  foreign = Bun.serve({ hostname: "127.0.0.1", port: Number(port), fetch: () => new Response() });
  const started = await serve(dir, ["start"]);
  expect(started.code).toBe(1);
  expect(started.output).toContain("Another server");
  expect(existsSync(stateFile())).toBe(false);

  const stopped = await serve(dir, ["stop"]);
  expect(stopped.code).toBe(1);
  expect(stopped.output).toContain("did not start");
});

test("startup failures are reported without leaving state", async () => {
  const dir = makeCheckout("a");
  const logged = await serve(dir, ["start"], { FAKE_EXIT_AFTER_LOG: "1" });
  expect(logged.code).toBe(1);
  expect(logged.output).toContain(`See ${logFile()}`);
  expect(existsSync(stateFile())).toBe(false);

  const silent = await serve(dir, ["start"], { FAKE_EXIT_BEFORE_LOG: "1" });
  expect(silent.code).toBe(1);
  expect(silent.output).toContain("without writing a log");
  expect(existsSync(logFile())).toBe(false);
  expect(existsSync(stateFile())).toBe(false);
});

test("a server that stops right after answering is not reported as started", async () => {
  const started = await serve(makeCheckout("a"), ["start"], { FAKE_EXIT_AFTER_MS: "300" });
  expect(started.code).toBe(1);
  expect(started.output).not.toContain("Listening on");
  expect(existsSync(stateFile())).toBe(false);
});

test("the port is checked after the model download", async () => {
  const dir = makeCheckout("a");
  rmSync(modelsDir(), { recursive: true });
  const starting = serve(dir, ["start"], { FAKE_DOWNLOAD_MS: "3000" });
  await Bun.sleep(1000);
  foreign = Bun.serve({ hostname: "127.0.0.1", port: Number(port), fetch: () => new Response() });
  const started = await starting;
  expect(started.code).toBe(1);
  expect(started.output).toContain("Another server");
  expect(existsSync(stateFile())).toBe(false);
});

test("checkouts share the model in the home directory", async () => {
  const dir = makeCheckout("a");
  const started = await serve(dir, ["start"], { FAKE_DOWNLOAD_CODE: "3" });
  expect(started.output).toContain("Listening on");
  expect(started.code).toBe(0);
  expect(existsSync(join(dir, "models"))).toBe(false);
});

test("MODELS_DIR replaces the model location", async () => {
  const dir = makeCheckout("a");
  const elsewhere = join(home, "日本語 パス");
  rmSync(modelsDir(), { recursive: true });
  writeModel(elsewhere);
  const started = await serve(dir, ["start"], { FAKE_DOWNLOAD_CODE: "3", MODELS_DIR: elsewhere });
  expect(started.output).toContain("Listening on");
  expect(started.code).toBe(0);
  await serve(dir, ["stop"]);

  const missing = await serve(dir, ["start"], { FAKE_DOWNLOAD_CODE: "3", MODELS_DIR: join(home, "empty") });
  expect(missing.code).toBe(3);
});

test("a failed model download does not start the server", async () => {
  const dir = makeCheckout("a");
  rmSync(modelsDir(), { recursive: true });
  const failed = await serve(dir, ["start"], { FAKE_DOWNLOAD_CODE: "3" });
  expect(failed.code).toBe(3);
  const killed = await serve(dir, ["start"], { FAKE_DOWNLOAD_SIGNAL: "1" });
  expect(killed.code).not.toBe(0);
  expect(await health()).toBeUndefined();
});

test("a proxy in the environment is not asked about the local server", async () => {
  const dir = makeCheckout("a");
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 407 }) });
  const started = await serve(dir, ["start"], { HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, NO_PROXY: "" });
  void proxy.stop(true);
  expect(started.output).toContain("Listening on");
  expect(started.code).toBe(0);
});

test("bad usage is an error", async () => {
  const dir = makeCheckout("a");
  for (const args of [[], ["2b"], ["start", "9b"], ["start", "../.."]]) {
    const result = await serve(dir, args);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Usage");
  }
});
