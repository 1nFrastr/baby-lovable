import { Daytona } from "@daytona/sdk";

let daytonaClient: Daytona | null = null;

export function getDaytonaClient(): Daytona {
  if (!daytonaClient) {
    daytonaClient = new Daytona({
      apiKey: process.env.DAYTONA_API_KEY,
      apiUrl: process.env.DAYTONA_API_URL,
      target: process.env.DAYTONA_TARGET,
    });
  }
  return daytonaClient;
}
