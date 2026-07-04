import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { env } from "./config/env.js";

type RedisUrl = { host: string; port: number; password?: string; db?: number };

const localLocks = new Set<string>();

function isRedisUnavailable(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT" || code === "ECONNRESET";
}

async function withLocalLock<T>(key: string, fn: () => Promise<T>) {
  if (localLocks.has(key)) throw Object.assign(new Error(`资源正忙，请稍后重试: ${key}`), { statusCode: 409 });
  localLocks.add(key);
  try {
    return await fn();
  } finally {
    localLocks.delete(key);
  }
}

function parseRedisUrl(value: string): RedisUrl {
  const url = new URL(value);
  return { host: url.hostname || "127.0.0.1", port: Number(url.port || 6379), password: url.password ? decodeURIComponent(url.password) : undefined, db: url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined };
}

function encodeCommand(parts: Array<string | number>) {
  return `*${parts.length}\r\n${parts.map((part) => {
    const text = String(part);
    return `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
  }).join("")}`;
}

async function readRedisReply(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.includes("\r\n")) cleanup(resolve, text);
    };
    const onError = (error: Error) => cleanup(reject, error);
    const cleanup = (done: (value: any) => void, value: any) => {
      socket.off("data", onData);
      socket.off("error", onError);
      done(value);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

async function redisCommand(parts: Array<string | number>) {
  const config = parseRedisUrl(env.redisUrl);
  const socket = createConnection({ host: config.host, port: config.port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  try {
    if (config.password) {
      socket.write(encodeCommand(["AUTH", config.password]));
      const auth = await readRedisReply(socket);
      if (auth.startsWith("-")) throw new Error(auth);
    }
    if (Number.isInteger(config.db)) {
      socket.write(encodeCommand(["SELECT", config.db ?? 0]));
      const selected = await readRedisReply(socket);
      if (selected.startsWith("-")) throw new Error(selected);
    }
    socket.write(encodeCommand(parts));
    return await readRedisReply(socket);
  } finally {
    socket.end();
  }
}

export async function acquireRedisLock(key: string, ttlMs = 15_000) {
  const token = randomUUID();
  const reply = await redisCommand(["SET", key, token, "NX", "PX", ttlMs]);
  if (!reply.startsWith("+OK")) throw Object.assign(new Error(`资源正忙，请稍后重试: ${key}`), { statusCode: 409 });
  return token;
}

export async function releaseRedisLock(key: string, token: string) {
  const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  await redisCommand(["EVAL", script, 1, key, token]);
}

export async function withRedisLock<T>(key: string, fn: () => Promise<T>, ttlMs = 15_000): Promise<T> {
  let token: string;
  try {
    token = await acquireRedisLock(key, ttlMs);
  } catch (error) {
    if (!isRedisUnavailable(error)) throw error;
    console.warn("redis unavailable, falling back to process-local lock", key, error);
    return withLocalLock(key, fn);
  }
  try {
    return await fn();
  } finally {
    await releaseRedisLock(key, token).catch((error) => console.warn("redis lock release failed", key, error));
  }
}
