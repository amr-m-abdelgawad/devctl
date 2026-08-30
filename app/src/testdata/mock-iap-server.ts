import { createServer, type Server } from "node:http";

export function startMockIapServer(expectedBearer: string): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const auth = String(req.headers.authorization ?? "");
      if (auth !== `Bearer ${expectedBearer}`) {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
      res.end("ok");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no address"));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}
