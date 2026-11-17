/**
 * The subset of a logger the business code needs. Fastify's (pino) logger satisfies it;
 * tests can pass a silent or recording stub.
 */
export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
