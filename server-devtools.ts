import "dotenv/config";
import type { IncomingMessage } from "node:http";
import ServerDevTools from "server-devtools";

console.log("SERVER_DEVTOOLS_DEBUG=", process.env.SERVER_DEVTOOLS_DEBUG)

const encryptionKey = process.env.SERVER_DEVTOOLS_ENCRYPTION_KEY;
if (!encryptionKey) {
  throw new Error("SERVER_DEVTOOLS_ENCRYPTION_KEY is required for this smoke test");
}

export const devtools = new ServerDevTools({
  auth: {
    username: "admin",
    password: "test-password",
  },
  encryption: { key: encryptionKey },
  getCurrentUser: (req) => {
    const user = (req as IncomingMessage & { user?: Record<string, unknown> }).user;
    return user && typeof user === "object" ? user : undefined;
  },
});

await devtools.start();
console.log("Started ServerDevTools successfully");
