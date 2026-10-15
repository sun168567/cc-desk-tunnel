// A failure the parent turns back into its own DomainError. The class does not cross the process boundary.
export class DomainError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
