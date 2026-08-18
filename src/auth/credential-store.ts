export type CredentialKey = Readonly<{
  origin: string;
  username: string;
}>;

export interface CredentialStore {
  get(key: CredentialKey): Promise<string | null>;
  set(key: CredentialKey, token: string): Promise<void>;
  delete(key: CredentialKey): Promise<void>;
}
