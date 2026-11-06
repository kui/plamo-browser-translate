// PLaMo 3 Translate の OpenAI 互換 API サーバーを、バックグラウンドで起動・停止する。
// 使い方: bun run serve start [2b|8b|0.8b|31b]   (既定 2b、ポート 8000)
//         bun run serve stop
import { rmSync } from "node:fs";
import { join } from "node:path";

const port = process.env.PORT || "8000";
const pidFile = join(import.meta.dir, "serve.pid");
const logFile = join(import.meta.dir, "serve.log");

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

async function runningPid(): Promise<number | undefined> {
  const file = Bun.file(pidFile);
  if (!(await file.exists())) return undefined;
  const pid = Number(await file.text());
  return isServer(pid) ? pid : undefined;
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
    const server = Bun.spawn(["llama-server", ...args], { stdio: ["ignore", "ignore", "ignore"], detached: true });
    server.unref();
    return server.pid;
  }
  // Bun.spawn の子は呼び出し元のパイプのハンドルまで受け継ぎ、サーバーが動いている間 `bun run serve start | ...` が
  // 終わらなくなる。Start-Process はハンドルを継承させない ShellExecute で起動する。
  const { stdout, exitCode } = Bun.spawnSync(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
      "(Start-Process llama-server -ArgumentList $env:SERVER_ARGS -WindowStyle Hidden -PassThru).Id"],
    { env: { ...process.env, SERVER_ARGS: args.map((arg) => `"${arg}"`).join(" ") } },
  );
  if (exitCode !== 0) process.exit(exitCode);
  return Number(stdout.toString());
}

async function start(size: string) {
  const running = await runningPid();
  if (running !== undefined) {
    console.log(`Already running (pid ${running}). To change the settings, run stop first.`);
    return;
  }

  requireCommand("llama-server");
  // 別のサーバーが応答していると、起動に失敗していても下の待機が成功してしまう。
  if ((await healthStatus()) !== undefined) {
    console.error(`Another server is already listening on port ${port}.`);
    process.exit(1);
  }

  const quant = process.env.QUANT || "Q4_K_M";
  const dir = join(import.meta.dir, "models", `plamo-3-translate-${size}-GGUF`);
  const ggufName = `plamo-3-translate-${size}-${quant}.gguf`;
  const gguf = join(dir, ggufName);
  const template = join(dir, "chat_template.jinja");

  if (!(await Bun.file(gguf).exists()) || !(await Bun.file(template).exists())) {
    requireCommand("uvx");
    const download = Bun.spawn([
      "uvx", "--from", "huggingface_hub", "hf", "download", `pfnet/plamo-3-translate-${size}-GGUF`, ggufName,
      "chat_template.jinja", "LICENSE/ja", "LICENSE/en", "--local-dir", dir,
    ], { stdio: ["inherit", "inherit", "inherit"] });
    const status = await download.exited;
    if (status !== 0) process.exit(status);
  }

  // GGUF に埋め込まれたテンプレートは古いので、同梱の chat_template.jinja を必ず使う（モデルカードの指示）。
  // -c は 4 スロットで割られる。1 スロット 16384 トークンあれば、長い段落でも入力と訳の両方が収まる。
  const pid = spawnServer([
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
  ]);
  await Bun.write(pidFile, String(pid));

  while (isServer(pid)) {
    if ((await healthStatus()) === 200) {
      console.log(`Listening on http://127.0.0.1:${port} (pid ${pid}). Log: ${logFile}`);
      return;
    }
    await Bun.sleep(200);
  }
  rmSync(pidFile, { force: true });
  console.error(`llama-server exited during startup. See ${logFile}`);
  process.exit(1);
}

async function stop() {
  const pid = await runningPid();
  if (pid !== undefined) {
    // Windows ではこの SIGTERM も強制終了になる。llama-server に保存する状態はないので、どちらでも問題ない。
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 10_000;
    while (isServer(pid) && Date.now() < deadline) await Bun.sleep(100);
    if (isServer(pid)) process.kill(pid, "SIGKILL");
    while (isServer(pid)) await Bun.sleep(100);
  }
  rmSync(pidFile, { force: true });
  console.log(pid === undefined ? "Not running." : `Stopped (pid ${pid}).`);
}

const [command, size = "2b"] = process.argv.slice(2);
switch (command) {
  case "start":
    await start(size);
    break;
  case "stop":
    await stop();
    break;
  default:
    console.error("Usage: bun run serve start [2b|8b|0.8b|31b] | stop");
    process.exit(1);
}
