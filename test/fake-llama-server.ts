// serve.ts のテストで llama-server と uvx の代わりに動く。コンパイルして、その名前で PATH に置く。
export {};

const value = (name: string) => process.argv[process.argv.indexOf(name) + 1]!;

if (process.argv.includes("--from")) {
  await Bun.sleep(Number(process.env.FAKE_DOWNLOAD_MS ?? 0));
  if (process.env.FAKE_DOWNLOAD_SIGNAL) process.kill(process.pid, "SIGTERM");
  process.exit(Number(process.env.FAKE_DOWNLOAD_CODE ?? 0));
}

const readyAt = Date.now() + Number(process.env.FAKE_LOAD_MS ?? 0);
if (process.env.FAKE_EXIT_AFTER_MS) setTimeout(() => process.exit(1), Number(process.env.FAKE_EXIT_AFTER_MS));

if (process.env.FAKE_EXIT_BEFORE_LOG) process.exit(1);

await Bun.write(value("--log-file"), "fake llama-server started\n");
if (process.env.FAKE_EXIT_AFTER_LOG) process.exit(1);

Bun.serve({
  hostname: "127.0.0.1",
  port: Number(value("--port")),
  fetch: () => new Response(null, { status: Date.now() < readyAt ? 503 : 200 }),
});
