import type { FastifyError, FastifyInstance } from "fastify";
import { InsufficientStockError, UnbalancedJournalError } from "@softilo/domain";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(public status: number, message: string, public code = "error") {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(404, `${what} not found`, "not_found");
export const unprocessable = (message: string) => new AppError(422, message, "unprocessable");
export const forbidden = (message = "You do not have permission to do this") => new AppError(403, message, "forbidden");

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: err.code, message: err.message });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: "validation",
        message: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
        issues: err.issues,
      });
    }
    if (err instanceof InsufficientStockError || err instanceof UnbalancedJournalError) {
      return reply.status(422).send({ error: "unprocessable", message: err.message });
    }
    // Postgres integrity rules (balanced entries, lock date, control accounts, append-only, RLS).
    const pgCode = (err as { code?: string }).code;
    if (pgCode === "23514" || pgCode === "23505" || pgCode === "23503") {
      return reply.status(422).send({ error: "unprocessable", message: err.message });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: "bad_request", message: err.message });
    req.log.error(err);
    return reply.status(500).send({ error: "internal", message: "Something went wrong" });
  });
}
