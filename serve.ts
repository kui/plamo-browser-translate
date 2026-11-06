// PLaMo 3 Translate の OpenAI 互換 API サーバーを、バックグラウンドで起動・停止し、状態を表示する。
// 使い方: bun run serve start [2b|8b|0.8b|31b]   (既定 2b、ポート 21434)
//         bun run serve stop
//         bun run serve status
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Server = { pid: number; size: string; quant: string };

class Failure extends Error {}

const sizes = ["0.8b", "2b", "8b", "31b"];
const usage = `Usage: bun run serve start [${sizes.join("|")}] | stop | status`;
const host = "127.0.0.1";
const port = process.env.PORT || "21434";
const quant = process.env.QUANT || "Q4_K_M";
const sleepIdleSeconds = process.env.SLEEP_IDLE_SECONDS || "300";
const hfEndpoint = process.env.HF_ENDPOINT || "https://huggingface.co";
// ポートはマシン全体で 1 つなので、状態もワークツリーではなくポートごとに持つ。どのワークツリーからでも同じサーバーを扱える。
const stateDir = join(homedir(), ".cache", "plamo-browser-translate");
const modelsDir = process.env.MODELS_DIR || join(stateDir, "models");
const stateFile = join(stateDir, `${port}.json`);
const lockDir = join(stateDir, `${port}.lock`);
const logFile = join(stateDir, `${port}.log`);
// ロックの中でするのは状態の確認とサーバーの起動だけ。保持したまま落ちた場合に備え、それより十分長く待って奪う。
const staleLockMs = 30_000;

// bun の fetch は 127.0.0.1 宛てでも HTTP_PROXY を使うので、プロキシの応答をサーバーの応答と取り違える。
process.env.NO_PROXY = [process.env.NO_PROXY, host].filter(Boolean).join(",");

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

// 状態ファイルは、同時に動く start や stop に壊されないよう、この中で読み書きする。status は表示するだけなので例外。
async function withLock<T>(action: () => Promise<T> | T): Promise<T> {
  mkdirSync(stateDir, { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      // Windows では、削除中のフォルダを作ろうとすると EPERM になる。
      if (!["EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    const lock = statSync(lockDir, { throwIfNoEntry: false });
    if (lock && Date.now() - lock.mtimeMs > staleLockMs) rmSync(lockDir, { recursive: true, force: true, maxRetries: 5 });
    await Bun.sleep(50);
  }
  try {
    return await action();
  } finally {
    rmSync(lockDir, { recursive: true, force: true, maxRetries: 5 });
  }
}

function liveServer(file: string): Server | undefined {
  let server: Partial<Server> = {};
  try {
    server = JSON.parse(readFileSync(file, "utf8")) ?? {};
  } catch {
    // ないファイルや壊れたファイルは、動いているサーバーがないのと同じに扱う。
  }
  return server.pid !== undefined && isServer(server.pid) ? server as Server : undefined;
}

function runningServer(): Server | undefined {
  const server = liveServer(stateFile);
  if (server === undefined) rmSync(stateFile, { force: true });
  return server;
}

async function healthStatus(target = port): Promise<number | undefined> {
  try {
    const response = await fetch(`http://${host}:${target}/health`, { signal: AbortSignal.timeout(1000) });
    return response.status;
  } catch {
    return undefined;
  }
}

function spawnServer(args: string[]): number | undefined {
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
    { env: { ...process.env, SERVER_ARGS: args.map((arg) => `"${arg}"`).join(" "), SERVER_CWD: stateDir }, stderr: "inherit" },
  );
  const pid = Number(stdout.toString());
  return exitCode === 0 && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function waitUntilListening(pid: number, gguf: string): Promise<boolean> {
  let announced = false;
  while (isServer(pid)) {
    // サーバーはダウンロードの間ポートを開かないので、この間の応答は別のサーバーのもの。
    if (existsSync(gguf) && (await healthStatus()) === 200) {
      // ポートを取れなかったサーバーは、そのポートにいる別のサーバーの 200 を受けた時点ではまだ終了していないことがある。
      await Bun.sleep(500);
      return isServer(pid);
    }
    if (!announced) {
      const task = existsSync(gguf) ? "load" : `download ${gguf} and load it`;
      console.log(`Waiting for the server to ${task} (pid ${pid}). Interrupting this leaves it running; use "bun run serve stop" to stop it.`);
      announced = true;
    }
    await Bun.sleep(200);
  }
  return false;
}

async function launch(size: string, args: string[]): Promise<Server> {
  if ((await healthStatus()) !== undefined) throw new Failure(`Another server is already listening on port ${port}.`);
  // 失敗の原因を読むときに前回のログを読まないよう、先に消す。引数の解析エラーなどはログに書かれない。
  rmSync(logFile, { force: true });
  const pid = spawnServer(args);
  if (pid === undefined) throw new Failure("Could not start llama-server.");
  const server = { pid, size, quant };
  await Bun.write(stateFile, JSON.stringify(server));
  return server;
}

// llama-server にはチャットテンプレートをダウンロードするオプションがない。
async function downloadTemplate(url: string, template: string, dir: string) {
  const response = await fetch(url).catch(() => undefined);
  if (!response?.ok) throw new Failure(`Could not download ${url}${response ? ` (status ${response.status})` : ""}.`);
  mkdirSync(dir, { recursive: true });
  const temporary = `${template}.${process.pid}`;
  await Bun.write(temporary, response);
  renameSync(temporary, template);
}

async function start(size: string) {
  requireCommand("llama-server");

  const dir = join(modelsDir, `plamo-3-translate-${size}-GGUF`);
  const ggufName = `plamo-3-translate-${size}-${quant}.gguf`;
  const gguf = join(dir, ggufName);
  const template = join(dir, "chat_template.jinja");
  const repo = `${hfEndpoint}/pfnet/plamo-3-translate-${size}-GGUF/resolve/main`;
  // GGUF に埋め込まれたテンプレートは古いので、同梱の chat_template.jinja を必ず使う（モデルカードの指示）。
  // -c は 4 スロットで割られる。1 スロット 16384 トークンあれば、長い段落でも入力と訳の両方が収まる。
  const args = [
    "-m", gguf,
    // ダウンロードは llama-server に任せる。中断しても次の起動で続きから再開する。
    ...(existsSync(gguf) ? [] : ["-mu", `${repo}/${ggufName}`]),
    "--chat-template-file", template,
    "--no-prefill-assistant",
    "--alias", "plamo-3-translate",
    "-c", "65536",
    "--parallel", "4",
    "--sleep-idle-seconds", sleepIdleSeconds,
    "--host", host,
    "--port", port,
    "--log-file", logFile,
    "--log-colors", "off",
  ];

  let server = await withLock(runningServer);
  if (server === undefined) {
    if (!existsSync(template)) await downloadTemplate(`${repo}/chat_template.jinja`, template, dir);
    server = await withLock(async () => runningServer() ?? await launch(size, args));
  }

  if (server.size !== size || server.quant !== quant) {
    throw new Failure(`Already running ${server.size} ${server.quant} on port ${port} (pid ${server.pid}). To change the settings, run stop first.`);
  }
  if (!(await waitUntilListening(server.pid, gguf))) {
    await withLock(runningServer);
    throw new Failure(existsSync(logFile)
      ? `llama-server exited during startup. See ${logFile}`
      : `llama-server exited during startup without writing a log. Run it directly to see the error:\nllama-server ${args.join(" ")}`);
  }
  console.log(`Listening on http://${host}:${port} (pid ${server.pid}). Log: ${logFile}`);
}

function kill(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    // 確かめてから送るまでの間に終了していれば、止める目的は果たせている。
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

const foreignServer = (target: string) => `Port ${target} is answered by a server that this command did not start.`;

async function stop() {
  const server = await withLock(runningServer);
  if (server === undefined) {
    if ((await healthStatus()) !== undefined) throw new Failure(foreignServer(port));
    console.log("Not running.");
    return;
  }
  // Windows ではこの SIGTERM も強制終了になる。llama-server に保存する状態はないので、どちらでも問題ない。
  kill(server.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (isServer(server.pid) && Date.now() < deadline) await Bun.sleep(100);
  if (isServer(server.pid)) kill(server.pid, "SIGKILL");
  while (isServer(server.pid)) await Bun.sleep(100);
  await withLock(runningServer);
  console.log(`Stopped (pid ${server.pid}).`);
}

// スクリプトから使えるよう、翻訳を受け付けるサーバーがあるときだけ終了コードを 0 にする。
async function status() {
  // PORT を指定しないときは、ポートを知らなくても確かめられるよう、状態ファイルのあるポートもすべて見る。
  const files = existsSync(stateDir) ? readdirSync(stateDir) : [];
  const saved = files.flatMap((file) => /^(\d+)\.json$/.exec(file)?.[1] ?? []);
  const targets = process.env.PORT ? [port] : [...new Set([port, ...saved])];
  const lines: string[] = [];
  let ready = false;
  for (const target of targets) {
    const server = liveServer(join(stateDir, `${target}.json`));
    const answer = await healthStatus(target);
    const url = `http://${host}:${target}`;
    if (server === undefined) {
      if (answer !== undefined) lines.push(foreignServer(target));
      continue;
    }
    const details = `(${server.size} ${server.quant}, pid ${server.pid})`;
    if (answer === 200) {
      ready = true;
      lines.push(`Running: listening on ${url} ${details}.`);
    } else {
      lines.push(`Starting: ${url} is not ready yet ${details}.`);
    }
  }
  console.log(lines.join("\n") || "Not running.");
  if (!ready) process.exitCode = 1;
}

const [command, size = "2b"] = process.argv.slice(2);
try {
  if (command === "start" && sizes.includes(size)) {
    await start(size);
  } else if (command === "stop") {
    await stop();
  } else if (command === "status") {
    await status();
  } else {
    throw new Failure(usage);
  }
} catch (error) {
  if (!(error instanceof Failure)) throw error;
  console.error(error.message);
  process.exit(1);
}
