export type GoogleStatus = {
  gcloudInstalled: boolean;
  adcAvailable: boolean;
  userEmail: string;
  projectID: string;
  projectSource: string;
  error?: Error;
};
