import { httpRouter } from "convex/server";
import { connectCookie, streamChat } from "./arena";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

// Streaming chat ke Arena Agent Mode (mirip arena_agent_test.py).
http.route({ path: "/arena/stream", method: "POST", handler: streamChat });
http.route({ path: "/arena/stream", method: "OPTIONS", handler: streamChat });

// Bookmarklet "ARENA AUTO-CONNECT": terima cookie langsung dari arena.ai.
http.route({
  path: "/arena/connect-cookie",
  method: "POST",
  handler: connectCookie,
});
http.route({
  path: "/arena/connect-cookie",
  method: "OPTIONS",
  handler: connectCookie,
});

export default http;
