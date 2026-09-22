export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
/** Arrays are sent as repeated keys (`status=a&status=b`), which Forgejo reads as a set. */
export type QueryValue = boolean | number | string | readonly string[] | undefined;

export type ForgejoRequest = Readonly<{
  method: HttpMethod;
  path: readonly string[];
  query?: Readonly<Record<string, QueryValue>>;
  body?: unknown;
  signal?: AbortSignal;
}>;

export type ForgejoAssetUpload = Readonly<{
  path: readonly string[];
  name: string;
  filename: string;
  content: Blob;
  signal?: AbortSignal;
}>;

export interface ForgejoApi {
  request(request: ForgejoRequest): Promise<unknown>;
}

export interface ForgejoAssetUploader {
  uploadAsset(request: ForgejoAssetUpload): Promise<unknown>;
}

export type ForgejoTextRequest = Readonly<{
  path: readonly string[];
  query?: Readonly<Record<string, QueryValue>>;
  /** Request only the last N bytes (`Range: bytes=-N`). */
  tailBytes?: number;
  signal?: AbortSignal;
}>;

export type ForgejoText = Readonly<{
  text: string;
  /** True when Forgejo answered 206 with part of the body. */
  partial: boolean;
  /** Size of the whole resource, or null when Forgejo did not say. */
  totalBytes: number | null;
}>;

export interface ForgejoTextReader {
  readText(request: ForgejoTextRequest): Promise<ForgejoText>;
}

export type ForgejoDownloadRequest = Readonly<{
  path: readonly string[];
  query?: Readonly<Record<string, QueryValue>>;
  signal?: AbortSignal;
}>;

export type ForgejoDownload = Readonly<{
  body: ReadableStream<Uint8Array>;
  contentType: string | null;
  declaredBytes: number | null;
}>;

export interface ForgejoDownloader {
  download(request: ForgejoDownloadRequest): Promise<ForgejoDownload>;
}
