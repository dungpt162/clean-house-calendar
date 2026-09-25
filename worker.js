// Cloudflare Worker: gửi thông báo đổ rác lên Discord theo Cron Trigger
// (cấu hình trong wrangler.jsonc), đồng thời phục vụ web tĩnh qua ASSETS.
import { buildMessage, vietnamToday } from "./notify-message.js";

async function sendDailyNotification(env) {
  if (!env.DISCORD_WEBHOOK_URL) {
    throw new Error("Thiếu secret DISCORD_WEBHOOK_URL");
  }
  const res = await env.ASSETS.fetch(new Request("https://assets.internal/schedule.json"));
  if (!res.ok) throw new Error("Không đọc được schedule.json: HTTP " + res.status);
  const schedule = await res.json();

  const content = buildMessage(schedule, vietnamToday());
  if (!content) {
    console.log("Cuối tuần - không đổ rác, bỏ qua.");
    return;
  }

  const post = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!post.ok) {
    throw new Error("Discord trả về HTTP " + post.status + ": " + (await post.text()));
  }
  console.log("Đã gửi thông báo:\n" + content);
}

export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDailyNotification(env));
  },
};
