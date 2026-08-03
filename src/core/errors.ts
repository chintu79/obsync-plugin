export class NetworkError extends Error {
  constructor(
    public kind: "connection" | "protocol" | "encryption" | "timeout" | "io",
    message: string
  ) {
    super(message);
    this.name = `NetworkError(${kind})`;
  }

  static connection(msg: string): NetworkError {
    return new NetworkError("connection", msg);
  }
  static protocol(msg: string): NetworkError {
    return new NetworkError("protocol", msg);
  }
  static encryption(msg: string): NetworkError {
    return new NetworkError("encryption", msg);
  }
  static timeout(): NetworkError {
    return new NetworkError("timeout", "timeout");
  }
  static io(msg: string): NetworkError {
    return new NetworkError("io", msg);
  }
}
