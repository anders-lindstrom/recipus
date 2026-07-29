import { handle } from "hono/vercel";
import { createApp } from "@/api";

const app = createApp();
const handler = handle(app);

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
};
