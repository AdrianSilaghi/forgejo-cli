export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
export type QueryValue = boolean | number | string | undefined;

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
