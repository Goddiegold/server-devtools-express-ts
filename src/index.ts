import express from "express";
import mongoose from "mongoose";
import { devtools } from "../server-devtools.js";

console.log("SERVER_DEVTOOLS_DEBUG=index.ts", process.env.SERVER_DEVTOOLS_DEBUG)


const mongoUri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    source: { type: String, required: true },
  },
  { collection: "users", timestamps: false },
);
const UserModel = mongoose.model("ExpressSmokeUser", userSchema);

type SmokeUser = { id: string; email: string; name: string };
type RequestWithUser = express.Request & { user?: SmokeUser };

const app = express();
app.use((req, _res, next) => {
  (req as RequestWithUser).user = {
    id: "user-123",
    email: "smoke@example.com",
    name: "Smoke User",
  };
  next();
});
app.use((req, res, next) => devtools.middleware(req, res, next));
app.use(express.json());

app.get("/hello", (_req, res) => res.json({ message: "Hello from Express" }));
app.post("/users", (req, res) => res.status(201).json(req.body));
app.get("/slow", async (_req, res) => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  res.json({ message: "Finished waiting" });
});
app.get("/not-found", (_req, res) => res.status(404).json({ error: "Not found" }));
app.get("/external", async (_req, res, next) => {
  try {
    const response = await fetch("https://jsonplaceholder.typicode.com/todos/1");
    res.status(response.status).json(await response.json());
  } catch (error) {
    next(error);
  }
});
app.get("/sensitive-test", async (_req, res, next) => {
  try {
    const response = await fetch("https://jsonplaceholder.typicode.com/posts", {
      method: "POST",
      headers: {
        Authorization: "Bearer smoke-test-secret-token",
        Cookie: "session=smoke-test-cookie",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        username: "smoke-user",
        password: "smoke-test-password",
        accessToken: "smoke-test-access-token",
      }),
    });
    res.status(response.status).json({ status: response.status, body: await response.json() });
  } catch (error) {
    next(error);
  }
});
app.get("/mongo-test", async (_req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(mongoUri, { dbName: "server_devtools_smoke" });
    }

    let document = await UserModel.findOne({ name: "ServerDevTools Mongoose Test" });
    if (!document) {
      document = await UserModel.create({
        name: "ServerDevTools Mongoose Test",
        source: "express",
      });
    }

    res.json(document);
  } catch (error) {
    next(error);
  }
});
app.get("/error", () => {
  throw new Error("Intentional Express smoke-test error");
});
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: error.message });
});

app.listen(4000, () => console.log("Express smoke app listening on http://localhost:4000"));
