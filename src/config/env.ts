import { z } from "zod";

const envSchema = z.object({
  apiUrl: z.string().url().default("https://fixion-center.onrender.com/v1"),
  appEnv: z
    .enum(["development", "staging", "production"])
    .default("production"),
  enableMockData: z.boolean().default(false),
  appVersion: z.string().default("1.0.0"),
  minSupportedVersion: z.string().default("1.0.0"),
});

export const env = envSchema.parse({
  apiUrl:
    process.env.EXPO_PUBLIC_API_URL ||
    "https://fixion-center.onrender.com/v1",
  appEnv: (process.env.EXPO_PUBLIC_APP_ENV as any) || "production",
  enableMockData: process.env.EXPO_PUBLIC_ENABLE_MOCK_DATA === "true",
  appVersion: "1.0.0",
  minSupportedVersion: "1.0.0",
});

export type Env = z.infer<typeof envSchema>;
