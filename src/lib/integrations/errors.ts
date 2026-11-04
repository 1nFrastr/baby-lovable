export class IntegrationError extends Error {
  operationId?: string;

  constructor(message: string, readonly status = 400, readonly code?: string) {
    super(message);
    this.name = "IntegrationError";
  }
}
