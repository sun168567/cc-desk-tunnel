// A failure the client can act on; `code` travels in the response frame and `message` is shown to the user.
export class DomainError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
