// Step 0 spike (throwaway): validate Spectrum Cloud end to end.
// Answers SP-1 (backfill after disconnect), SP-2 (shared-line identity),
// and confirms the SDK API shapes the spec relies on.
//
// Run: bun spike/spectrum-hello.ts
// Then: reply to the iMessage you receive; watch stdout.
// For SP-1: Ctrl-C the process, text it again while dead, restart, and see
// whether the missed message arrives.

import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const target = process.env.SPIKE_TARGET_PHONE;
if (!target) {
  console.error("Set SPIKE_TARGET_PHONE in .env (E.164, e.g. +14805551234)");
  process.exit(1);
}

console.log(`[spike] connecting to Spectrum Cloud...`);
const app = await Spectrum({
  projectId: process.env.SPECTRUM_PROJECT_ID!,
  projectSecret: process.env.SPECTRUM_PROJECT_SECRET!,
  platforms: [imessage.config()],
});
console.log(`[spike] connected`);

const im = imessage(app);
const space = await im.space.create(target);
console.log(`[spike] space resolved: id=${space.id}`);

await space.send(
  `Spike test ${new Date().toLocaleTimeString()}: reply to this and watch the terminal. Reply STOP-SPIKE to end.`,
);
console.log(`[spike] hello sent to ${target}; listening for replies...`);

for await (const [msgSpace, message] of app.messages) {
  const content = message.content as { type: string; text?: string };
  const text = content.type === "text" ? content.text : undefined;
  console.log(
    `[spike] inbound: space=${msgSpace.id} dir=${message.direction} content.type=${content.type} text=${JSON.stringify(text)} sender=${JSON.stringify(message.sender)}`,
  );
  if (text === undefined) continue; // receipts/reactions/etc: log only
  if (text?.trim().toUpperCase() === "STOP-SPIKE") {
    await msgSpace.send("Spike over. 👋");
    break;
  }
  await msgSpace.send(`Echo: ${text ?? "(non-text message)"}`);
}

await app.stop();
console.log(`[spike] done`);
