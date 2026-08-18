import type { Readable } from "node:stream";

import { CliError } from "../core/errors.js";

const MAX_TOKEN_BYTES = 4096;
const TOKEN_PROMPT = "Forgejo personal access token: ";

export type TokenReadOptions = Readonly<{
  pipedOnly: boolean;
}>;

export interface TokenInput {
  read(options: TokenReadOptions): Promise<string>;
}

export interface HiddenTokenPrompt {
  readHidden(message: string): Promise<string>;
}

export type TokenInputStream = Readable &
  Readonly<{
    isTTY?: boolean;
  }>;

export type HiddenPromptInput = Readable & {
  isRaw?: boolean;
  setRawMode?(enabled: boolean): unknown;
};

export type HiddenPromptOutput = Readonly<{
  write(value: string): unknown;
}>;

function validateToken(token: string): string {
  if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
    throw new CliError("validation_failed", "Token input exceeds the 4096-byte limit.");
  }
  if (token.length === 0 || /[\r\n]/.test(token) || token.trim() !== token) {
    throw new CliError(
      "validation_failed",
      "Token input must contain exactly one non-empty token.",
    );
  }
  return token;
}

export async function readTokenFromStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > MAX_TOKEN_BYTES) {
      throw new CliError("validation_failed", "Token input exceeds the 4096-byte limit.");
    }
    chunks.push(buffer);
  }

  let token = Buffer.concat(chunks).toString("utf8");
  if (token.endsWith("\n")) {
    token = token.slice(0, -1);
    if (token.endsWith("\r")) {
      token = token.slice(0, -1);
    }
  }

  return validateToken(token);
}

export class SecureTokenInput implements TokenInput {
  readonly #stream: TokenInputStream;
  readonly #prompt: HiddenTokenPrompt;

  public constructor(options: Readonly<{ stream: TokenInputStream; prompt: HiddenTokenPrompt }>) {
    this.#stream = options.stream;
    this.#prompt = options.prompt;
  }

  public async read(options: TokenReadOptions): Promise<string> {
    if (this.#stream.isTTY !== true) return readTokenFromStream(this.#stream);
    if (options.pipedOnly) {
      throw new CliError(
        "validation_failed",
        "The --with-token option requires a token piped through standard input.",
      );
    }
    return validateToken(await this.#prompt.readHidden(TOKEN_PROMPT));
  }
}

export class ReadlineHiddenTokenPrompt implements HiddenTokenPrompt {
  readonly #input: HiddenPromptInput;
  readonly #output: HiddenPromptOutput;

  public constructor(options: Readonly<{ input: HiddenPromptInput; output: HiddenPromptOutput }>) {
    this.#input = options.input;
    this.#output = options.output;
  }

  public async readHidden(message: string): Promise<string> {
    if (this.#input.setRawMode === undefined) {
      throw new CliError("validation_failed", "Secure terminal input is unavailable.");
    }

    const wasRaw = this.#input.isRaw === true;
    this.#output.write(message);
    this.#input.setRawMode(true);
    this.#input.setEncoding("utf8");
    this.#input.resume();

    try {
      return await new Promise<string>((resolve, reject) => {
        let token = "";
        let settled = false;

        const finish = (result: string | CliError): void => {
          if (settled) return;
          settled = true;
          this.#input.off("data", onData);
          this.#input.off("end", onEnd);
          this.#input.off("error", onError);
          if (typeof result === "string") resolve(result);
          else reject(result);
        };
        const onEnd = (): void =>
          finish(new CliError("validation_failed", "Token input ended before submission."));
        const onError = (): void =>
          finish(new CliError("validation_failed", "Token input could not be read."));
        const onData = (chunk: string | Buffer): void => {
          for (const character of String(chunk)) {
            if (character === "\u0003") {
              finish(new CliError("cancelled", "Token entry was cancelled."));
              return;
            }
            if (character === "\r" || character === "\n") {
              finish(token);
              return;
            }
            if (character === "\b" || character === "\u007f") {
              token = [...token].slice(0, -1).join("");
              continue;
            }
            token += character;
            if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
              finish(new CliError("validation_failed", "Token input exceeds the 4096-byte limit."));
              return;
            }
          }
        };

        this.#input.on("data", onData);
        this.#input.once("end", onEnd);
        this.#input.once("error", onError);
      });
    } finally {
      if (!wasRaw) this.#input.setRawMode(false);
      this.#input.pause();
      this.#output.write("\n");
    }
  }
}
