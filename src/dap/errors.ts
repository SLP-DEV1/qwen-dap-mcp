export class DapError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DapError';
  }
}

export class DapRequestError extends DapError {
  readonly command: string;
  readonly responseBody: unknown;

  constructor(command: string, message: string, responseBody?: unknown) {
    super(`DAP request '${command}' failed: ${message}`);
    this.name = 'DapRequestError';
    this.command = command;
    this.responseBody = responseBody;
  }
}

export class DapTimeoutError extends DapError {
  constructor(operation: string, timeoutMs: number) {
    super(`Timed out waiting for ${operation} after ${timeoutMs} ms`);
    this.name = 'DapTimeoutError';
  }
}
