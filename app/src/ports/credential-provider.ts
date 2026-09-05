export type AccessToken = {
  accessToken: string;
  tokenType: string;
  expiresAt: Date;
  audience: string;
  identity: string;
  scopes: string[];
};

export type CredentialProvider = {
  get(identity: string, audience: string, scopes: string[]): Promise<AccessToken>;
};
