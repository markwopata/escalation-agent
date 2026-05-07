import process from "node:process";
import { getFrostyStatus } from "./lib/frosty-client.mjs";

try {
  const status = await getFrostyStatus();
  console.log(JSON.stringify(status, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
