// PLaMo 3 Translate の OpenAI 互換 API サーバーを、バックグラウンドで起動・停止する。
// 使い方: bun run serve start [2b|8b|0.8b|31b]   (既定 2b、ポート 8000)
//         bun run serve stop
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Server = { pid: number; size: string; quant: string };

const sizes = ["0.8b", "2b", "8b", "31b"];
const usage = `Usage: bun run serve start [${sizes.join("|")}] | stop`;
const port = process.env.PORT || "8000";
const quant = process.env.QUANT || "Q4_K_M";
// ポートはマシン全体で 1 つなので、状態もワークツリーではなくポートごとに持つ。どのワークツリーからでも同じサーバーを扱える。
const stateDir = join(homedir(), ".cache", "plamo-browser-translate");
const stateFile = join(stateDir, `${port}.pid`);
const logFile = join(stateDir, `${port}.log`);
// spawn より前に状態ファイルを作るので、作った start が中断すると pid のないまま残る。起動にかかる時間より十分長く待って見切る。
const claimTimeoutMs = 30_000;

function requireCommand(command: string) {
  if (!Bun.which(command)) {
    console.error(`${command} is not on PATH. See the requirements in README.md.`);
    process.exit(1);
  }
}

// PID は OS の再起動などで別のプロセスに再利用されるので、プロセス名も確かめる。
function isServer(pid: number): boolean {
  const command = process.platform === "win32"
    ? ["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]
    : ["ps", "-o", "comm=", "-p", String(pid)];
  return Bun.spawnSync(command).stdout.toString().includes("llama-server");
}

function readStateFile(): { fields: Partial<Server>; mtimeMs: number } | undefined {
  try {
    const text = readFileSync(stateFile, "utf8");
    const { mtimeMs } = statSync(stateFile);
    try {
      return { fields: JSON.parse(text), mtimeMs };
    } catch {
      return { fields: {}, mtimeMs };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function forgetServer(pid: number) {
  if (readStateFile()?.fields.pid === pid) rmSync(stateFile, { force: true });
}

async function runningServer(): Promise<Server | undefined> {
  for (;;) {
    const state = readStateFile();
    if (state === undefined) return undefined;
    if (state.fields.pid !== undefined) {
      if (isServer(state.fields.pid)) return state.fields as Server;
      forgetServer(state.fields.pid);
      return undefined;
    }
    if (Date.now() - state.mtimeMs > claimTimeoutMs) {
      rmSync(stateFile, { force: true });
      return undefined;
    }
    await Bun.sleep(100);
  }
}

function claim(size: string): boolean {
  mkdirSync(stateDir, { recursive: true });
  try {
    const file = openSync(stateFile, "wx");
    writeSync(file, JSON.stringify({ size, quant }));
    closeSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function healthStatus(): Promise<number | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return response.status;
  } catch {
    return undefined;
  }
}

function spawnServer(args: string[]): number {
  if (process.platform !== "win32") {
    const server = Bun.spawn(["llama-server", ...args], { cwd: stateDir, stdio: ["ignore", "ignore", "ignore"], detached: true });
    server.unref();
    return server.pid;
  }
  // Bun.spawn の子は呼び出し元のパイプのハンドルまで受け継ぎ、サーバーが動いている間 `bun run serve start | ...` が
  // 終わらなくなる。Start-Process はハンドルを継承させない ShellExecute で起動する。
  const { stdout, exitCode } = Bun.spawnSync(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
      "(Start-Process llama-server -ArgumentList $env:SERVER_ARGS -WorkingDirectory $env:SERVER_CWD -WindowStyle Hidden -PassThru).Id"],
    { env: { ...process.env, SERVER_ARGS: args.map((arg) => `"${arg}"`).join(" "), SERVER_CWD: stateDir } },
  );
  if (exitCode !== 0) process.exit(exitCode);
  return Number(stdout.toString());
}

async function waitUntilListening(pid: number): Promise<boolean> {
  while (isServer(pid)) {
    if ((await healthStatus()) === 200) {
      // ポートを取れなかったサーバーは、そのポートにいる別のサーバーの 200 を受けた時点ではまだ終了していないことがある。
      await Bun.sleep(500);
      return isServer(pid);
    }
    await Bun.sleep(200);
  }
  return false;
}

async function launch(size: string, args: string[]): Promise<Server> {
  // モデルの取得には時間がかかるので、ポートの確認は取得のあと、起動の直前に行う。
  if ((await healthStatus()) !== undefined) {
    rmSync(stateFile, { force: true });
    console.error(`Another server is already listening on port ${port}.`);
    process.exit(1);
  }
  const server = { pid: spawnServer(args), size, quant };
  await Bun.write(stateFile, JSON.stringify(server));
  return server;
}

async function start(size: string) {
  requireCommand("llama-server");

  const dir = join(import.meta.dir, "models", `plamo-3-translate-${size}-GGUF`);
  const ggufName = `plamo-3-translate-${size}-${quant}.gguf`;
  const gguf = join(dir, ggufName);
  const template = join(dir, "chat_template.jinja");
  // GGUF に埋め込まれたテンプレートは古いので、同梱の chat_template.jinja を必ず使う（モデルカードの指示）。
  // -c は 4 スロットで割られる。1 スロット 16384 トークンあれば、長い段落でも入力と訳の両方が収まる。
  const args = [
    "-m", gguf,
    "--chat-template-file", template,
    "--no-prefill-assistant",
    "--alias", "plamo-3-translate",
    "-c", "65536",
    "--parallel", "4",
    "--host", "127.0.0.1",
    "--port", port,
    "--log-file", logFile,
    "--log-colors", "off",
  ];

  let server = await runningServer();
  if (server === undefined) {
    if (!(await Bun.file(gguf).exists()) || !(await Bun.file(template).exists())) {
      requireCommand("uvx");
      const download = Bun.spawn([
        "uvx", "--from", "huggingface_hub", "hf", "download", `pfnet/plamo-3-translate-${size}-GGUF`, ggufName,
        "chat_template.jinja", "LICENSE/ja", "LICENSE/en", "--local-dir", dir,
      ], { stdio: ["inherit", "inherit", "inherit"] });
      const status = await download.exited;
      if (status !== 0) process.exit(status);
    }
    while (server === undefined && !claim(size)) server = await runningServer();
    server ??= await launch(size, args);
  }

  if (server.size !== size || server.quant !== quant) {
    console.error(`Already running ${server.size} ${server.quant} on port ${port} (pid ${server.pid}). To change the settings, run stop first.`);
    process.exit(1);
  }
  if (!(await waitUntilListening(server.pid))) {
    forgetServer(server.pid);
    console.error(`llama-server exited during startup. See ${logFile}`);
    process.exit(1);
  }
  console.log(`Listening on http://127.0.0.1:${port} (pid ${server.pid}). Log: ${logFile}`);
}

async function stop() {
  const server = await runningServer();
  if (server === undefined) {
    if ((await healthStatus()) !== undefined) {
      console.error(`Port ${port} is answered by a server that this command did not start.`);
      process.exit(1);
    }
    console.log("Not running.");
    return;
  }
  // Windows ではこの SIGTERM も強制終了になる。llama-server に保存する状態はないので、どちらでも問題ない。
  process.kill(server.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (isServer(server.pid) && Date.now() < deadline) await Bun.sleep(100);
  if (isServer(server.pid)) process.kill(server.pid, "SIGKILL");
  while (isServer(server.pid)) await Bun.sleep(100);
  forgetServer(server.pid);
  console.log(`Stopped (pid ${server.pid}).`);
}

const [command, size = "2b"] = process.argv.slice(2);
if (command === "start" && sizes.includes(size)) {
  await start(size);
} else if (command === "stop") {
  await stop();
} else {
  console.error(usage);
  process.exit(1);
}
