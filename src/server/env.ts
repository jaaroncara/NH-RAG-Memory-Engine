import dotenv from "dotenv";
import path from "node:path";

const globalState = globalThis as typeof globalThis & {
  __nhRagEnvLoaded?: boolean;
};

if (!globalState.__nhRagEnvLoaded) {
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
  dotenv.config();
  globalState.__nhRagEnvLoaded = true;
}
