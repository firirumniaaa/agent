import { httpRouter } from "convex/server";
import { streamChat } from "./arena";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

// Streaming chat ke Arena Agent Mode (mirip arena_agent_test.py).
http.route({ path: "/arena/stream", method: "POST", handler: streamChat });
http.route({ path: "/arena/stream", method: "OPTIONS", handler: streamChat });

export default http;
