/**
 * E7 测试基建：起一个临时端口的 HTTP server 供鉴权/配对集成测试使用。
 * 空 ServiceCollection 即可——鉴权中间件在路由之前生效，不依赖业务服务。
 */
import { once } from "node:events";
import type { Server } from "node:http";
import { ServiceCollection } from "@zcode/services";
import { createHttpServer } from "../../src/http.js";

export interface TestHttpServerHandle {
  port: number;
  baseUrl: string;
  close(): Promise<void>;
}

export async function startTestHttpServer(
  options: Parameters<typeof createHttpServer>[2] = {},
): Promise<TestHttpServerHandle> {
  const services = new ServiceCollection();
  const server = createHttpServer(services, 0, options);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test http server did not listen on a tcp port");
  }
  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        (server as Server).close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
