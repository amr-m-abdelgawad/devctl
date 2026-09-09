export type AccessToken = {
  accessToken: string;
  tokenType: string;
  expiresAt: Date;
  audience: string;
  identity: string;
  scopes: string[];
};

export type OAuthClientCredentials = {
  readonly clientId: string;
  readonly clientSecret: string;
};

export type CredentialProvider = {
  get(identity: string, audience: string, scopes: string[], oauth?: OAuthClientCredentials): Promise<AccessToken>;
};
