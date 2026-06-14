import type { FastifyRequest } from "fastify";

export type SessionUser = {
  kind: "admin" | "tenant";
  userId: string;
  name: string;
  schemaName?: string;
};

export type AuthedRequest = FastifyRequest & {
  user?: SessionUser;
};
