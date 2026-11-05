async ({ res }) => {
  const choice = res && res.choices && res.choices[0];
  if (!choice || !choice.message) {
    throw new Error("Unexpected response from llama-server: " + JSON.stringify(res).slice(0, 200));
  }
  // 上限で止まった訳を返すと、KISS は途中までの訳を完了扱いでキャッシュする。
  if (choice.finish_reason === "length") {
    throw new Error("Translation was cut off at the token limit. Split the paragraph or raise -c in serve.ts.");
  }
  const text = (choice.message.content || "").split("<​|plamo:").join("<|plamo:");
  return { translations: [[text.trim()]] };
}
